-- Runs once, on the primary's first start. The replica gets it through replication.
-- Tables from docs/ARCHITECTURE.md §4.

CREATE TYPE exchange   AS ENUM ('NSE', 'BSE');
CREATE TYPE side       AS ENUM ('BUY', 'SELL');
CREATE TYPE note_state AS ENUM ('SENT', 'FAILED');

CREATE TABLE users (
  id    bigint PRIMARY KEY,
  email text   NOT NULL UNIQUE,
  name  text   NOT NULL
);

CREATE TABLE trades (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint        NOT NULL REFERENCES users (id),
  trade_date date          NOT NULL,
  symbol     text          NOT NULL,
  side       side          NOT NULL,
  qty        integer       NOT NULL CHECK (qty > 0),
  price      numeric(12,2) NOT NULL,
  exchange   exchange      NOT NULL,
  traded_at  timestamptz   NOT NULL
);

-- Extract reads one trade date, walking users in order (keyset pagination).
CREATE INDEX trades_trade_date_user_id_idx ON trades (trade_date, user_id);

CREATE TABLE note_status (
  user_id        bigint      NOT NULL REFERENCES users (id),
  trade_date     date        NOT NULL,
  status         note_state  NOT NULL,
  s3_key         text,
  ses_message_id text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trade_date)
);
