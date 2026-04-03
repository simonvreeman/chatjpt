-- articles: main content table (replaces the bundled index records)
CREATE TABLE articles (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  site          TEXT NOT NULL DEFAULT 'cityguys.nl',
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'BlogPosting',
  description   TEXT,
  date_published TEXT,
  keywords      TEXT,
  search_weight REAL NOT NULL DEFAULT 1.0,
  text          TEXT NOT NULL,
  schema_object TEXT,
  city          TEXT,
  neighborhoods TEXT,
  categories    TEXT,
  cuisine_type  TEXT,
  occasion      TEXT,
  dishes        TEXT,
  content_hash  TEXT
);

-- article_places: normalized table for the places array
CREATE TABLE article_places (
  article_id    TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  neighborhood  TEXT,
  PRIMARY KEY (article_id, name)
);

-- Indexes for common query patterns
CREATE INDEX idx_articles_city ON articles(city);
CREATE INDEX idx_articles_type ON articles(type);
CREATE INDEX idx_places_name ON article_places(name);
