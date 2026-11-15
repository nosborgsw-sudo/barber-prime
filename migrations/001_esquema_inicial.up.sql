-- Barber Prime: esquema inicial (PostgreSQL >= 14).
-- Regra central: reservas e bloqueios geram linhas na MESMA tabela "occupations",
-- protegida por uma única exclusion constraint por barbeiro. As linhas de ocupação
-- são mantidas só por triggers, nunca pela aplicação.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE shops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  timezone      text NOT NULL DEFAULT 'America/Sao_Paulo' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  address       text NOT NULL DEFAULT '' CHECK (char_length(address) <= 300),
  contact_phone text NULL CHECK (contact_phone ~ '^\+55[1-9][0-9]{9,10}$'),
  cancel_window_minutes integer NOT NULL DEFAULT 120 CHECK (cancel_window_minutes BETWEEN 0 AND 10080),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  role          text NOT NULL CHECK (role IN ('barber', 'admin')),
  bio           text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
  login         text NULL CHECK (login ~ '^[a-z0-9._-]{3,100}$'),
  password_hash text NULL CHECK (char_length(password_hash) BETWEEN 20 AND 512),
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((login IS NULL) = (password_hash IS NULL))
);
CREATE UNIQUE INDEX staff_login_key ON staff (login) WHERE login IS NOT NULL;
CREATE INDEX staff_shop_idx ON staff (shop_id, sort_order);

CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  -- E.164 brasileiro já normalizado pela aplicação (db/telefone.mjs); o CHECK impede gravar texto cru.
  phone              text NOT NULL CHECK (phone ~ '^\+55[1-9][1-9](9[0-9]{8}|[2-5][0-9]{7})$'),
  phone_verified_at  timestamptz NULL,
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_phone_key UNIQUE (phone)
);

CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_cents       integer NOT NULL CHECK (price_cents BETWEEN 0 AND 1000000),
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_shop_idx ON services (shop_id, sort_order);

CREATE TABLE working_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local  time NOT NULL,
  end_local    time NOT NULL,
  valid_from   date NOT NULL DEFAULT DATE '2000-01-01',
  valid_until  date NULL,
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (end_local > start_local),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  -- Turnos do mesmo barbeiro no mesmo dia não se sobrepõem.
  CONSTRAINT working_hours_sem_sobreposicao EXCLUDE USING gist (
    staff_id WITH =, weekday WITH =,
    daterange(valid_from, valid_until, '[]') WITH &&,
    tsrange(DATE '2000-01-01' + start_local, DATE '2000-01-01' + end_local, '[)') WITH &&
  )
);
CREATE INDEX working_hours_staff_idx ON working_hours (staff_id, weekday);

CREATE TABLE appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  staff_id          uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  service_id        uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  start_at          timestamptz NOT NULL CHECK (isfinite(start_at)),
  end_at            timestamptz NOT NULL CHECK (isfinite(end_at)),
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_cents       integer NOT NULL CHECK (price_cents BETWEEN 0 AND 1000000),
  status            text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show')),
  notes             text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  cancelled_at      timestamptz NULL,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at = start_at + make_interval(mins => duration_minutes)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX appointments_customer_idx ON appointments (customer_id, start_at DESC);
CREATE INDEX appointments_staff_period_idx ON appointments (staff_id, start_at);
CREATE INDEX appointments_service_idx ON appointments (service_id);

CREATE TABLE blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  start_at    timestamptz NOT NULL CHECK (isfinite(start_at)),
  end_at      timestamptz NOT NULL CHECK (isfinite(end_at)),
  reason      text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  created_by  uuid NULL REFERENCES staff(id) ON DELETE SET NULL,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX blocks_staff_period_idx ON blocks (staff_id, start_at);
CREATE INDEX blocks_created_by_idx ON blocks (created_by);

-- Ocupação unificada: a única fonte de verdade contra conflito de horário.
CREATE TABLE occupations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id        uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  period          tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
                                            AND NOT lower_inf(period) AND NOT upper_inf(period)),
  appointment_id  uuid NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  block_id        uuid NULL UNIQUE REFERENCES blocks(id) ON DELETE CASCADE,
  CHECK (num_nonnulls(appointment_id, block_id) = 1),
  CONSTRAINT occupations_sem_conflito EXCLUDE USING gist (staff_id WITH =, period WITH &&)
);

CREATE FUNCTION sync_appointment_occupation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    DELETE FROM occupations WHERE appointment_id = NEW.id;
  ELSE
    INSERT INTO occupations (staff_id, period, appointment_id)
    VALUES (NEW.staff_id, tstzrange(NEW.start_at, NEW.end_at, '[)'), NEW.id)
    ON CONFLICT (appointment_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, period = EXCLUDED.period;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER appointments_occupation
AFTER INSERT OR UPDATE OF staff_id, start_at, end_at, status ON appointments
FOR EACH ROW EXECUTE FUNCTION sync_appointment_occupation();

CREATE FUNCTION sync_block_occupation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO occupations (staff_id, period, block_id)
  VALUES (NEW.staff_id, tstzrange(NEW.start_at, NEW.end_at, '[)'), NEW.id)
  ON CONFLICT (block_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, period = EXCLUDED.period;
  RETURN NULL;
END $$;

CREATE TRIGGER blocks_occupation
AFTER INSERT OR UPDATE OF staff_id, start_at, end_at ON blocks
FOR EACH ROW EXECUTE FUNCTION sync_block_occupation();

-- Atendimento encerrado não volta a ser confirmado; cancelado não é reaberto.
CREATE FUNCTION guard_appointment_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'confirmed' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'transicao de status invalida: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_status_transition';
  END IF;
  IF OLD.status <> 'confirmed' AND (NEW.start_at <> OLD.start_at OR NEW.staff_id <> OLD.staff_id) THEN
    RAISE EXCEPTION 'reserva encerrada nao pode ser reagendada'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_status_transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER appointments_status_guard
BEFORE UPDATE ON appointments
FOR EACH ROW EXECUTE FUNCTION guard_appointment_status();

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  role          text NOT NULL CHECK (role IN ('anonymous', 'customer', 'barber', 'admin')),
  customer_id   uuid NULL REFERENCES customers(id) ON DELETE CASCADE,
  staff_id      uuid NULL REFERENCES staff(id) ON DELETE CASCADE,
  csrf_hash     bytea NULL CHECK (octet_length(csrf_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (role = 'anonymous' AND customer_id IS NULL AND staff_id IS NULL) OR
    (role = 'customer'  AND customer_id IS NOT NULL AND staff_id IS NULL) OR
    (role IN ('barber', 'admin') AND staff_id IS NOT NULL AND customer_id IS NULL)
  )
);
CREATE INDEX sessions_customer_idx ON sessions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX sessions_staff_idx ON sessions (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash   bytea NOT NULL CHECK (octet_length(phone_hash) = 32),
  customer_id  uuid NULL REFERENCES customers(id) ON DELETE CASCADE,
  code_hash    bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts     smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX challenges_phone_idx ON challenges (phone_hash, created_at DESC);
CREATE INDEX challenges_customer_idx ON challenges (customer_id);

CREATE TABLE idempotency_keys (
  principal_id    uuid NOT NULL,
  key             text NOT NULL CHECK (char_length(key) BETWEEN 16 AND 128),
  request_hash    bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  appointment_id  uuid NULL REFERENCES appointments(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, key)
);
CREATE INDEX idempotency_keys_appointment_idx ON idempotency_keys (appointment_id);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE rate_limits (
  bucket        text NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 200),
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL DEFAULT 1 CHECK (hits >= 1),
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

CREATE TABLE outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key    text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  topic         text NOT NULL CHECK (topic IN ('appointment.confirmed', 'appointment.rescheduled', 'appointment.cancelled', 'challenge.requested')),
  payload       jsonb NOT NULL,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at  timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz NULL,
  last_error    text NULL CHECK (char_length(last_error) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE sent_at IS NULL;

CREATE TABLE audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid NULL,
  action      text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
  entity_id   uuid NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
