import { config as loadEnv } from "dotenv";
import { DataSource } from "typeorm";
import { Asset } from "../assets/asset.entity";

loadEnv();

/**
 * Claims images stored before ownership existed.
 *
 * The migration leaves older rows unowned on purpose — the service cannot
 * know who uploaded them, and guessing would hand one merchant's pictures to
 * another. That is the safe default, and the wrong one for a bucket that only
 * ever served a single shop, where it means the media library goes empty.
 *
 * So it is a separate, explicit step: name the scope, see the count, confirm.
 * Only rows with no owner are ever touched.
 *
 *   npm run backfill-scope -- store:acme
 *   npm run backfill-scope -- store:acme --commit
 */
async function backfill() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const scope = args.find((a) => !a.startsWith("--"));

  if (!scope) {
    console.error(
      "Which scope? e.g. `npm run backfill-scope -- store:acme`.\n" +
        "Without --commit it only reports what it would do.",
    );
    process.exit(1);
  }
  if (scope.length > 190) {
    console.error("Scope must be 190 characters or fewer");
    process.exit(1);
  }

  const ds = new DataSource({
    type: "mysql",
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? "my_store_assets",
    entities: [Asset],
    synchronize: false,
  });

  await ds.initialize();
  try {
    const assets = ds.getRepository(Asset);
    const total = await assets.count();
    const unowned = await assets.countBy({ scope: "" });

    console.log(`${total} assets total, ${unowned} with no owner.`);
    if (!unowned) return;

    if (!commit) {
      console.log(
        `Would assign those ${unowned} to "${scope}". ` +
          "Re-run with --commit to do it.",
      );
      return;
    }

    // Only the unowned: an asset already claimed by one shop must never be
    // reassigned by a script run with the wrong argument.
    const result = await assets.update({ scope: "" }, { scope });
    console.log(`Assigned ${result.affected ?? 0} assets to "${scope}".`);
  } finally {
    await ds.destroy();
  }
}

backfill().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
