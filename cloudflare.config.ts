import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, bindings, defineGadgetsWorker, type DurableObjectMigration,
  type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-jottacloud",
  entrypoint: ".wrangler/validate/src/index.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
  env: {
    // What readAsMarkdown()'s conversion runs on (env.WORKERS_AI.toMarkdown()), the same mechanism
    // the Workshop's webFetch agent tool uses.
    WORKERS_AI: bindings.ai(),
  },
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "JottacloudGatekeeperImpl"] },
];
