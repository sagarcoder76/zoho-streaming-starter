'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const jwt = require('@fastify/jwt');
const rateLimit = require('@fastify/rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1024 * 1024 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const isProduction = process.env.NODE_ENV === 'production';
const appOrigin = process.env.APP_ORIGIN || 'http://localhost';
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('Set JWT_SECRET to a random secret of at least 32 characters.');
}

app.register(cookie);
app.register(jwt, { secret: jwtSecret, sign: { expiresIn: '15m' } });
app.register(rateLimit, { global: false });
app.decorateRequest('admin', null);

const safeEqual = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/admin/')) return;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(appOrigin).origin) {
        return reply.code(403).send({ error: 'Origin not allowed.' });
      }
    } catch {
      return reply.code(403).send({ error: 'Invalid request origin.' });
    }
  }
});

async function authenticate(request, reply) {
  const token = request.cookies?.zoho_admin;
  if (!token) return reply.code(401).send({ error: 'Admin sign-in required.' });
  let claims;
  try {
    claims = await app.jwt.verify(token);
  } catch {
    reply.clearCookie('zoho_admin', { path: '/api/admin' });
    return reply.code(401).send({ error: 'Session expired. Sign in again.' });
  }
  const result = await pool.query(
    'SELECT id, email, role, is_active FROM admin_users WHERE id = $1',
    [claims.sub]
  );
  if (!result.rowCount || !result.rows[0].is_active) {
    reply.clearCookie('zoho_admin', { path: '/api/admin' });
    return reply.code(401).send({ error: 'Admin account is inactive.' });
  }
  request.admin = result.rows[0];
}

function allowRoles(...roles) {
  return async function roleGuard(request, reply) {
    if (!request.admin) return reply.code(401).send({ error: 'Admin sign-in required.' });
    if (!roles.includes(request.admin.role)) {
      return reply.code(403).send({ error: 'Your admin role cannot perform this action.' });
    }
  };
}

async function audit(actorId, action, objectType, objectId, details = {}) {
  await pool.query(
    `INSERT INTO admin_audit_log (actor_id, action, object_type, object_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId || null, action, objectType, objectId == null ? null : String(objectId), JSON.stringify(details)]
  );
}

function cleanGenres(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
  return [];
}

function serializeTitle(row) {
  return {
    id: row.slug,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    genre: Array.isArray(row.genres) ? row.genres.join(', ') : String(row.genre || ''),
    year: row.release_year,
    runtime: row.runtime_label,
    rating: row.maturity_rating,
    director: row.director,
    synopsis: row.synopsis,
    status: row.status
  };
}

app.get('/api/health', async () => ({ ok: true, service: 'zoho-api' }));

// Public catalog defaults to worldwide-cleared titles only. Territory-specific
// release filtering belongs at the CDN/API edge before global launch.
app.get('/api/catalog', async (request, reply) => {
  const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 24, 1), 60);
  const offset = Math.max(Number.parseInt(request.query.offset, 10) || 0, 0);
  const values = [];
  const where = [
    `t.status = 'published'`,
    `EXISTS (
      SELECT 1 FROM title_rights r
      WHERE r.title_id = t.id AND r.territory_code = '*'
        AND r.streaming_allowed = TRUE
        AND (r.valid_from IS NULL OR r.valid_from <= CURRENT_DATE)
        AND (r.valid_until IS NULL OR r.valid_until >= CURRENT_DATE)
    )`
  ];
  const kind = typeof request.query.kind === 'string' ? request.query.kind : '';
  if (['Film', 'Series', 'Documentary'].includes(kind)) {
    values.push(kind);
    where.push(`t.kind = $${values.length}`);
  }
  const genre = typeof request.query.genre === 'string' ? request.query.genre.trim().slice(0, 60) : '';
  if (genre) {
    values.push(genre);
    where.push(`$${values.length} = ANY(t.genres)`);
  }
  const q = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 100) : '';
  if (q) {
    values.push(`%${q}%`);
    where.push(`(t.title ILIKE $${values.length} OR t.director ILIKE $${values.length} OR t.synopsis ILIKE $${values.length})`);
  }
  values.push(limit, offset);
  try {
    const result = await pool.query(
      `SELECT t.* FROM titles t WHERE ${where.join(' AND ')}
       ORDER BY t.release_year DESC NULLS LAST, t.title ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { items: result.rows.map(serializeTitle), limit, offset };
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Catalog query failed.' });
  }
});

app.get('/api/catalog/:slug', async (request, reply) => {
  const result = await pool.query(
    `SELECT t.* FROM titles t WHERE t.slug = $1 AND t.status = 'published'
     AND EXISTS (
       SELECT 1 FROM title_rights r WHERE r.title_id = t.id AND r.territory_code = '*'
       AND r.streaming_allowed = TRUE
       AND (r.valid_from IS NULL OR r.valid_from <= CURRENT_DATE)
       AND (r.valid_until IS NULL OR r.valid_until >= CURRENT_DATE)
     )`,
    [request.params.slug]
  );
  if (!result.rowCount) return reply.code(404).send({ error: 'Title not found.' });
  return serializeTitle(result.rows[0]);
});

app.post('/api/admin/login', {
  config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
}, async (request, reply) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!email || !password || email.length > 254 || password.length > 256) {
    return reply.code(400).send({ error: 'Email and password are required.' });
  }
  const result = await pool.query(
    'SELECT id, email, password_hash, role, is_active FROM admin_users WHERE LOWER(email) = $1',
    [email]
  );
  const user = result.rows[0];
  const valid = user && user.is_active && await bcrypt.compare(password, user.password_hash);
  if (!valid) return reply.code(401).send({ error: 'Email or password is incorrect.' });
  const token = app.jwt.sign({ sub: user.id });
  reply.setCookie('zoho_admin', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'Strict',
    path: '/api/admin',
    maxAge: 15 * 60
  });
  return { admin: { email: user.email, role: user.role }, expiresIn: 900 };
});

app.post('/api/admin/logout', async (request, reply) => {
  reply.clearCookie('zoho_admin', { path: '/api/admin', httpOnly: true, secure: isProduction, sameSite: 'Strict' });
  return { ok: true };
});

app.get('/api/admin/me', { preHandler: [authenticate] }, async request => ({
  admin: { id: request.admin.id, email: request.admin.email, role: request.admin.role }
}));

app.get('/api/admin/titles', { preHandler: [authenticate, allowRoles('owner', 'admin', 'editor')] }, async request => {
  const result = await pool.query('SELECT * FROM titles ORDER BY updated_at DESC LIMIT 500');
  return { items: result.rows.map(serializeTitle) };
});

app.post('/api/admin/titles', { preHandler: [authenticate, allowRoles('owner', 'admin', 'editor')] }, async (request, reply) => {
  const b = request.body || {};
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const kind = b.kind;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || title.length < 1 || title.length > 180 || !['Film', 'Series', 'Documentary'].includes(kind)) {
    return reply.code(400).send({ error: 'Provide a title, a URL-safe slug, and a valid kind.' });
  }
  const year = Number.isInteger(b.year) ? b.year : null;
  const result = await pool.query(
    `INSERT INTO titles (slug,title,kind,genres,release_year,runtime_label,maturity_rating,director,synopsis,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING *`,
    [slug, title, kind, cleanGenres(b.genre || b.genres), year, b.runtime || null, b.rating || null, b.director || null, String(b.synopsis || '').slice(0, 3000), request.admin.id]
  ).catch(error => {
    if (error.code === '23505') return null;
    throw error;
  });
  if (!result) return reply.code(409).send({ error: 'That slug is already in use.' });
  await audit(request.admin.id, 'title.create', 'title', result.rows[0].id, { slug });
  return reply.code(201).send(serializeTitle(result.rows[0]));
});

app.patch('/api/admin/titles/:slug', { preHandler: [authenticate, allowRoles('owner', 'admin', 'editor')] }, async (request, reply) => {
  const current = await pool.query('SELECT * FROM titles WHERE slug = $1', [request.params.slug]);
  if (!current.rowCount) return reply.code(404).send({ error: 'Title not found.' });
  if (request.admin.role === 'editor' && current.rows[0].status !== 'draft') {
    return reply.code(403).send({ error: 'Editors may only change draft titles.' });
  }
  const b = request.body || {};
  const allowed = ['title', 'kind', 'genres', 'year', 'runtime', 'rating', 'director', 'synopsis'];
  if (request.admin.role !== 'editor') allowed.push('status');
  const fields = [];
  const values = [];
  const map = { title: 'title', kind: 'kind', genres: 'genres', year: 'release_year', runtime: 'runtime_label', rating: 'maturity_rating', director: 'director', synopsis: 'synopsis', status: 'status' };
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
    let value = b[key];
    if (key === 'genres') value = cleanGenres(value);
    if (key === 'synopsis') value = String(value).slice(0, 3000);
    if (key === 'year') value = Number.isInteger(value) ? value : null;
    if (key === 'kind' && !['Film', 'Series', 'Documentary'].includes(value)) return reply.code(400).send({ error: 'Invalid title kind.' });
    if (key === 'status' && !['draft', 'archived'].includes(value)) return reply.code(400).send({ error: 'Use the rights-checked publish action to publish a title.' });
    values.push(value);
    fields.push(`${map[key]} = $${values.length}`);
  }
  if (!fields.length) return reply.code(400).send({ error: 'No editable fields were supplied.' });
  fields.push('updated_at = NOW()');
  values.push(request.params.slug);
  const updated = await pool.query(`UPDATE titles SET ${fields.join(', ')} WHERE slug = $${values.length} RETURNING *`, values);
  await audit(request.admin.id, 'title.update', 'title', updated.rows[0].id, { fields: Object.keys(b) });
  return serializeTitle(updated.rows[0]);
});

app.post('/api/admin/titles/:slug/rights', { preHandler: [authenticate, allowRoles('owner', 'admin')] }, async (request, reply) => {
  const b = request.body || {};
  const territory = typeof b.territory === 'string' ? b.territory.trim().toUpperCase() : '';
  if (!/^\*$|^[A-Z]{2}$/.test(territory)) return reply.code(400).send({ error: 'Territory must be * for worldwide or a two-letter territory code.' });
  const title = await pool.query('SELECT id FROM titles WHERE slug = $1', [request.params.slug]);
  if (!title.rowCount) return reply.code(404).send({ error: 'Title not found.' });
  const result = await pool.query(
    `INSERT INTO title_rights (title_id,territory_code,streaming_allowed,downloads_allowed,evidence_reference,valid_from,valid_until,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (title_id,territory_code) DO UPDATE SET streaming_allowed=EXCLUDED.streaming_allowed,
       downloads_allowed=EXCLUDED.downloads_allowed,evidence_reference=EXCLUDED.evidence_reference,
       valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until
     RETURNING id`,
    [title.rows[0].id, territory, b.streamingAllowed === true, b.downloadsAllowed === true, String(b.evidenceReference || '').slice(0, 500) || null, b.validFrom || null, b.validUntil || null, request.admin.id]
  );
  await audit(request.admin.id, 'rights.upsert', 'title', title.rows[0].id, { territory, streamingAllowed: b.streamingAllowed === true, downloadsAllowed: b.downloadsAllowed === true });
  return reply.code(201).send({ id: result.rows[0].id, territory });
});

app.post('/api/admin/titles/:slug/publish', { preHandler: [authenticate, allowRoles('owner', 'admin')] }, async (request, reply) => {
  const result = await pool.query(
    `UPDATE titles t SET status='published', updated_at=NOW()
     WHERE t.slug=$1 AND EXISTS (
       SELECT 1 FROM title_rights r WHERE r.title_id=t.id AND r.territory_code='*'
       AND r.streaming_allowed=TRUE
       AND (r.valid_from IS NULL OR r.valid_from <= CURRENT_DATE)
       AND (r.valid_until IS NULL OR r.valid_until >= CURRENT_DATE)
     ) RETURNING t.*`,
    [request.params.slug]
  );
  if (!result.rowCount) return reply.code(409).send({ error: 'Cannot publish: add current worldwide streaming rights first.' });
  await audit(request.admin.id, 'title.publish', 'title', result.rows[0].id, { slug: request.params.slug });
  return serializeTitle(result.rows[0]);
});

app.get('/api/admin/users', { preHandler: [authenticate, allowRoles('owner')] }, async () => {
  const result = await pool.query('SELECT id,email,role,is_active,created_at FROM admin_users ORDER BY created_at');
  return { items: result.rows };
});

app.post('/api/admin/users', { preHandler: [authenticate, allowRoles('owner')] }, async (request, reply) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  const role = request.body?.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 256 || !['admin', 'editor'].includes(role)) {
    return reply.code(400).send({ error: 'Provide a valid email, password of at least 12 characters, and role admin or editor.' });
  }
  const hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    'INSERT INTO admin_users (email,password_hash,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id,email,role,is_active,created_at',
    [email, hash, role]
  );
  if (!result.rowCount) return reply.code(409).send({ error: 'That admin email already exists.' });
  await audit(request.admin.id, 'admin.create', 'admin_user', result.rows[0].id, { email, role });
  return reply.code(201).send(result.rows[0]);
});

app.patch('/api/admin/users/:id/role', { preHandler: [authenticate, allowRoles('owner')] }, async (request, reply) => {
  const role = request.body?.role;
  const active = request.body?.isActive;
  if (!['owner', 'admin', 'editor'].includes(role) || typeof active !== 'boolean') {
    return reply.code(400).send({ error: 'Provide a valid role and isActive boolean.' });
  }
  if (request.params.id === request.admin.id && (role !== 'owner' || active !== true)) {
    return reply.code(400).send({ error: 'Use another Owner account to change your own access.' });
  }
  const result = await pool.query(
    'UPDATE admin_users SET role=$1,is_active=$2,updated_at=NOW() WHERE id=$3 RETURNING id,email,role,is_active,created_at',
    [role, active, request.params.id]
  );
  if (!result.rowCount) return reply.code(404).send({ error: 'Admin user not found.' });
  await audit(request.admin.id, 'admin.role.update', 'admin_user', request.params.id, { role, active });
  return result.rows[0];
});

async function bootstrapOwner() {
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM admin_users WHERE role='owner'");
  if (count.rows[0].n > 0) return;
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) {
    app.log.warn('No Owner account exists. Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD for first-time setup.');
    return;
  }
  if (password.length < 16) throw new Error('BOOTSTRAP_OWNER_PASSWORD must have at least 16 characters.');
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO admin_users (email,password_hash,role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING",
    [email, hash]
  );
  app.log.info({ email }, 'Created the initial Owner account. Remove bootstrap credentials from the environment now.');
}

async function start() {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'seed.sql'), 'utf8'));
  await bootstrapOwner();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

async function shutdown(signal) {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
start().catch(error => {
  app.log.error(error);
  process.exit(1);
});
