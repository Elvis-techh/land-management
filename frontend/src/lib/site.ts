/*
 * `import.meta.env` is Vite's, and the test runner has no Vite — the same guard
 * as lib/googleDrive.ts.
 */
const environment: Record<string, string | undefined> =
  typeof import.meta.env === "undefined" ? {} : import.meta.env;

/**
 * Whether this build is the test site: a second Lindero with fake data, which
 * the Deploy test workflow builds with VITE_SITE=test. Decided at build time,
 * so it is known before the first request and even if the server is down.
 */
export const isTestSite = environment.VITE_SITE === "test";

/**
 * Who a message goes to. On the test site, nobody: the demo customers' numbers
 * and addresses are made up, but a made-up number can still be a real stranger's.
 * WhatsApp then asks who to send it to, so a test message can go to yourself.
 */
export function messageRecipient(address: string): string {
  return isTestSite ? "" : address;
}
