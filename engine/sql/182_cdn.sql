-- +migrate Up
ALTER TABLE workflow ADD COLUMN icon_url text;

-- +migrate Down
ALTER TABLE workflow DROP COLUMN icon_url;
