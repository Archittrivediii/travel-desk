-- Example data. Running this file replaces everything in the Travel Desk tables.
TRUNCATE expenses, trips, budgets, policy, users CASCADE;
ALTER SEQUENCE trip_seq RESTART WITH 14;
ALTER SEQUENCE expense_seq RESTART WITH 104;
ALTER SEQUENCE claim_seq RESTART WITH 1;
ALTER SEQUENCE pms_seq RESTART WITH 1;

INSERT INTO users (id, code, name, role, grade, dept, desig) VALUES
  ('u1','0011','Priya Nair','employee','L3','Sales','Manager'),
  ('u2','0012','Karan Singh','employee','L2','Engineering','Executive'),
  ('u3','0013','Meera Iyer','employee','L4','Engineering','Sr. Manager'),
  ('u4','0014','Rahul Mehta','manager','L4','Sales','Sr. Manager'),
  ('u5','0015','Anita Desai','admin','L5','Finance','General Manager'),
  ('u6','0016','Vikram Rao','manager','L4','Engineering','Sr. Manager');

INSERT INTO policy (grade, cls, hotel, da) VALUES
  ('L1',0,3500,800),('L2',0,4500,1000),('L3',0,6000,1200),('L4',1,8000,1500),('L5',2,12000,2000);

INSERT INTO budgets (dept, amount) VALUES ('Sales',400000),('Engineering',350000),('Finance',80000);

INSERT INTO trips (id, emp, from_city, to_city, dep, ret, purpose, cls, fare, hotel, status) VALUES
  ('TR-2610-008','u1','DEL','PNQ','2026-10-05','2026-10-07','Partner onboarding workshop',0,7600,5500,'Approved'),
  ('TR-2610-009','u3','BLR','HYD','2026-10-15','2026-10-16','Data centre site review',1,6100,7000,'Approved'),
  ('TR-2610-010','u2','DEL','MAA','2026-10-08','2026-10-09','Vendor demo',0,9800,4200,'Rejected'),
  ('TR-2610-011','u1','DEL','BOM','2026-10-20','2026-10-22','Quarterly client review',0,9200,5800,'Pending manager'),
  ('TR-2610-012','u2','DEL','BLR','2026-10-26','2026-10-30','Customer deployment support',0,8400,5200,'Pending manager'),
  ('TR-2610-013','u4','DEL','CCU','2026-11-03','2026-11-06','Regional sales summit',2,21500,7800,'Pending finance');

INSERT INTO expenses (id, emp, trip_id, section, mode, d_from, d_to, from_loc, to_loc, city, qty, rate, amt, cur, note, region, status) VALUES
  ('EX-101','u1','TR-2610-008','Travel Mode','Taxi / Cab','2026-10-06','2026-10-06','Airport','Site','Pune',1,1840,1840,'INR','Airport and site transfers','dom','Reimbursed'),
  ('EX-102','u1','TR-2610-008','Food','Dinner','2026-10-07','2026-10-07','','','Pune',1,2150,2150,'INR','Team dinner','dom','Pending HOD'),
  ('EX-103','u3','TR-2610-009','Travel Mode','Taxi / Cab','2026-10-12','2026-10-12','Airport','Hotel','Hyderabad',1,960,960,'INR','Pre-booked pickup deposit','dom','Pending HOD');
