# Running the asset service in Docker

Built for a single VPS, the same shape as the API. The service and MariaDB run
as two containers; nginx and TLS stay on the host.

This service owns object storage. You upload a file, it returns an id and a
public url, and the API stores those two values — it never touches the bucket
itself. The files live in S3 behind a CDN; only the metadata is in MariaDB.

## Differences from the API

- **No server-level grant.** The API creates a database per store, so its user
  needs `CREATE` across the server. This service has one database, created by
  Compose, so its user needs nothing beyond it. There is no init script here.
- **Migrations run themselves.** The schema is built by migrations that the app
  executes on start-up, so a fresh volume needs no manual step. Set
  `MIGRATIONS_RUN=false` to run them as a separate deploy step instead.
- **S3 is required for uploads.** The service refuses to start without
  `AWS_REGION`, and uploads fail without a bucket and credentials. Reads of
  existing assets keep working regardless, because their urls point at the CDN.

## First run

```bash
git clone git@github.com:my-store-org/asset-service.git /srv/my-store-assets
cd /srv/my-store-assets

cp .env.docker.example .env
$EDITOR .env          # bucket, AWS keys and CORS_ORIGINS

docker compose up -d --build
docker compose ps     # both services healthy
```

The stack comes up with the S3 fields still blank, so you can verify it before
wiring storage. Check it with:

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:3003/assets?limit=1'
# 200
```

That 200 is the healthy signal: the service answered, and it could only do that
after querying the assets table — which means the database is reachable and the
migration has run. The container healthcheck asserts exactly this.

Do not use `/assets/<some-id>` for this. The id is parsed as a UUID, so an
invented value answers 400 without the database being touched at all — it looks
like a live service whether or not the schema exists.

```bash
docker compose exec asset-service node scripts/preflight.js
```

## Nginx and TLS

The service publishes to `127.0.0.1:3003` only, so nginx on the host proxies to
it on its own subdomain. Copy the API's vhost and change the two values:

```nginx
server_name asset.my-store.shop;
...
location / {
    proxy_pass http://127.0.0.1:3003;
    # Uploads are files, not JSON — this needs to be larger than the API's.
    client_max_body_size 25M;
    proxy_set_header Host $host;
    ...
}
```

`client_max_body_size` is the one that bites: leave it at the API's 4M and
larger images fail with a 413 that looks like a bug in the console.

Whatever hostname you choose has to match `ASSET_SERVICE_URL` in the API's
environment, and the console's `NEXT_PUBLIC_ASSET_SERVICE_URL`. The account
currently has a website called `asset.my-store.shop`, singular — the API was
pointed at `assets.` with an s, which has no DNS record at all.

## Sharing one database server

Two Compose stacks means two MariaDB containers. That is deliberate: each
service owns its data and they can be moved or restored independently. If the
VPS is small enough that the second instance matters, delete the `mariadb`
service here, point `DB_HOST` at the API's container over a shared external
network, and create this service's database and user by hand.

## Updating

```bash
git pull
docker compose up -d --build
```

## Backups

Only metadata lives here — the objects are in S3, which has its own durability
and versioning. Still worth having:

```bash
docker compose exec mariadb sh -c \
  'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --single-transaction my_store_assets' \
  | gzip > "assets-$(date +%F).sql.gz"
```

Losing this database does not lose the images, but it does lose the mapping
from asset id to object key, which is what every product row references.

## A note on the committed template

`.env.production.example` is committed and currently contains a real database
password, host and user rather than placeholders. Anyone with read access to
the repository has them. Worth clearing and rotating.
