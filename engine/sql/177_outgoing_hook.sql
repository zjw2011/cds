-- +migrate Up

ALTER TABLE integration_model ADD COLUMN outgoing_hook BOOLEAN NOT NULL DEFAULT false;

-- +migrate Down

ALTER TABLE integration_model DROP COLUMN outgoing_hook;
