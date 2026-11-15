-- Reference data: the category taxonomy and a starter rule set of national
-- (Canadian) chains. Nothing here is personal; your own rules live only in
-- your local database.

INSERT INTO categories (name, kind, is_system) VALUES
  ('Groceries', 'expense', 1),
  ('Dining & Coffee', 'expense', 1),
  ('Transportation', 'expense', 1),
  ('Shopping', 'expense', 1),
  ('Subscriptions & Software', 'expense', 1),
  ('Phone & Internet', 'expense', 1),
  ('Entertainment', 'expense', 1),
  ('Health & Personal Care', 'expense', 1),
  ('Education', 'expense', 1),
  ('Housing & Utilities', 'expense', 1),
  ('Travel', 'expense', 1),
  ('Fees & Interest', 'expense', 1),
  ('Gifts & Donations', 'expense', 1),
  ('Other', 'expense', 1),
  ('Uncategorized', 'expense', 1),
  ('Card Payments', 'excluded', 1),
  ('Rewards & Credits', 'excluded', 1);

WITH seed (pattern, category) AS (VALUES
  -- Groceries
  ('METRO', 'Groceries'), ('NOFRILLS', 'Groceries'), ('NO FRILLS', 'Groceries'),
  ('LOBLAWS', 'Groceries'), ('WAL-MART', 'Groceries'), ('WALMART', 'Groceries'),
  ('COSTCO', 'Groceries'), ('FOOD BASICS', 'Groceries'), ('FRESHCO', 'Groceries'),
  ('SOBEYS', 'Groceries'), ('FARM BOY', 'Groceries'), ('SUPERSTORE', 'Groceries'),
  ('SUPERMARKET', 'Groceries'), ('LONGO', 'Groceries'), ('WHOLE FOODS', 'Groceries'),
  ('T&T', 'Groceries'), ('GROCER', 'Groceries'),
  -- Dining & coffee
  ('TIM HORTONS', 'Dining & Coffee'), ('STARBUCKS', 'Dining & Coffee'),
  ('MCDONALD', 'Dining & Coffee'), ('SUBWAY', 'Dining & Coffee'),
  ('FRESHSLICE', 'Dining & Coffee'), ('CHARTWELLS', 'Dining & Coffee'),
  ('BURRITO', 'Dining & Coffee'), ('PIZZA', 'Dining & Coffee'),
  ('A&W', 'Dining & Coffee'), ('WENDY', 'Dining & Coffee'),
  ('POPEYES', 'Dining & Coffee'), ('KFC', 'Dining & Coffee'),
  ('DOMINO', 'Dining & Coffee'), ('TACO BELL', 'Dining & Coffee'),
  ('UBER EATS', 'Dining & Coffee'), ('UBEREATS', 'Dining & Coffee'),
  ('DOORDASH', 'Dining & Coffee'), ('SKIPTHEDISHES', 'Dining & Coffee'),
  ('CHIPOTLE', 'Dining & Coffee'), ('SECOND CUP', 'Dining & Coffee'),
  ('COFFEE', 'Dining & Coffee'), ('RESTAURANT', 'Dining & Coffee'),
  ('SHAWARMA', 'Dining & Coffee'), ('SUSHI', 'Dining & Coffee'),
  ('BAKERY', 'Dining & Coffee'), ('CAFE', 'Dining & Coffee'),
  -- Transportation
  ('PRESTO', 'Transportation'), ('TTC', 'Transportation'),
  ('METROLINX', 'Transportation'), ('GO TRANSIT', 'Transportation'),
  ('UBER', 'Transportation'), ('LYFT', 'Transportation'),
  ('SHELL', 'Transportation'), ('PETRO', 'Transportation'),
  ('ESSO', 'Transportation'), ('PARKING', 'Transportation'),
  ('IMPARK', 'Transportation'), ('VIA RAIL', 'Transportation'),
  -- Shopping
  ('DOLLARAMA', 'Shopping'), ('AMAZON', 'Shopping'), ('AMZN', 'Shopping'),
  ('IKEA', 'Shopping'), ('BEST BUY', 'Shopping'), ('CANADIAN TIRE', 'Shopping'),
  ('WINNERS', 'Shopping'), ('SKECHERS', 'Shopping'), ('UNIQLO', 'Shopping'),
  ('HOME DEPOT', 'Shopping'), ('STAPLES', 'Shopping'),
  -- Subscriptions & software
  ('ANTHROPIC', 'Subscriptions & Software'), ('CLAUDE', 'Subscriptions & Software'),
  ('OPENAI', 'Subscriptions & Software'), ('CHATGPT', 'Subscriptions & Software'),
  ('GITHUB', 'Subscriptions & Software'), ('SPOTIFY', 'Subscriptions & Software'),
  ('NETFLIX', 'Subscriptions & Software'), ('GOOGLE ONE', 'Subscriptions & Software'),
  ('GOOGLE*', 'Subscriptions & Software'), ('APPLE.COM/BILL', 'Subscriptions & Software'),
  ('DISNEY PLUS', 'Subscriptions & Software'), ('YOUTUBE', 'Subscriptions & Software'),
  ('MICROSOFT', 'Subscriptions & Software'), ('ADOBE', 'Subscriptions & Software'),
  ('NOTION', 'Subscriptions & Software'), ('AMAZON PRIME', 'Subscriptions & Software'),
  ('PRIME VIDEO', 'Subscriptions & Software'),
  -- Phone & internet
  ('FIDO', 'Phone & Internet'), ('ROGERS', 'Phone & Internet'),
  ('BELL MOBILITY', 'Phone & Internet'), ('BELL CANADA', 'Phone & Internet'),
  ('TELUS', 'Phone & Internet'), ('KOODO', 'Phone & Internet'),
  ('FREEDOM MOBILE', 'Phone & Internet'), ('PUBLIC MOBILE', 'Phone & Internet'),
  ('VIRGIN PLUS', 'Phone & Internet'),
  -- Health & personal care
  ('SHOPPERS DRUG', 'Health & Personal Care'), ('REXALL', 'Health & Personal Care'),
  ('PHARMA', 'Health & Personal Care'), ('DENTAL', 'Health & Personal Care'),
  -- Education
  ('UNIVERSITY', 'Education'), ('COLLEGE', 'Education'),
  ('BOOKSTORE', 'Education'), ('TUITION', 'Education'),
  -- Entertainment
  ('CINEPLEX', 'Entertainment'), ('TICKETMASTER', 'Entertainment'), ('STEAM', 'Entertainment'),
  -- Travel
  ('AIR CANADA', 'Travel'), ('WESTJET', 'Travel'), ('AIRBNB', 'Travel'), ('HOTEL', 'Travel'),
  -- Other services
  ('UPS*', 'Other'), ('CANADA POST', 'Other'), ('CPC / SCP', 'Other'), ('FEDEX', 'Other')
)
INSERT INTO rules (pattern, category_id, source, priority)
SELECT seed.pattern, categories.id, 'seed', 100
FROM seed JOIN categories ON categories.name = seed.category;
