-- Fictional starter records only. No distribution rights are implied.
INSERT INTO titles (slug,title,kind,genres,release_year,runtime_label,maturity_rating,director,synopsis,status) VALUES
('map-of-low-tide','The Map of Low Tide','Film',ARRAY['Drama'],2025,'1h 52m','13+','Leela Mathew','A retired surveyor returns to the Konkan coast to chart a village that surfaces for eleven minutes each spring tide.','draft'),
('after-the-monsoon','After the Monsoon','Series',ARRAY['Mystery'],2024,'6 × 38m','16+','Kabir Das','A Kerala hydrologist returns to an estate where the flooded well gives up letters dated tomorrow.','draft'),
('the-brass-room','The Brass Room','Film',ARRAY['Mystery'],2023,'1h 38m','16+','Ira Bose','A Kolkata piano tuner is paid to silence one key in a room rented by strangers.','draft'),
('northbound','Northbound, 4:17','Film',ARRAY['Romance'],2025,'1h 44m','13+','Abeer Khan','Two night-shift strangers share a compartment between Shimla and a station that is no longer on the timetable.','draft'),
('paper-boats','Paper Boats in April','Film',ARRAY['Drama'],2022,'1h 29m','PG','Naina Kurian','When a Chennai print shop closes, its owner finds a decade of unsent letters tucked behind the press.','draft'),
('last-radio','The Last Radio in Lahaul','Documentary',ARRAY['Documentary'],2024,'1h 14m','PG','Tashi Dolma','A retired weather observer keeps a valley’s last shortwave station alive through one long winter.','draft'),
('month-of-sundays','A Month of Sundays','Series',ARRAY['Family drama'],2023,'8 × 29m','13+','Ankur Sen','Three siblings inherit their father’s failing cinema and agree to keep it open until the final Sunday matinee.','draft'),
('salt-country','Salt Country','Film',ARRAY['Drama'],2025,'1h 41m','16+','Devika Menon','In Kutch, a salt worker searches the flats for the survey stone that could save her family’s season.','draft'),
('house-of-birds','A House Full of Birds','Documentary',ARRAY['Documentary'],2024,'1h 22m','PG','Arvind Rao','For one year, a Mumbai building’s residents catalogue the birds nesting in its old water tank.','draft')
ON CONFLICT (slug) DO NOTHING;
