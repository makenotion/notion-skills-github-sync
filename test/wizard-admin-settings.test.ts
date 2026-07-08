import { describe, expect, test } from "bun:test";
import {
  ADMIN_CONNECTIONS_PATH,
  PAT_SETTING_NAME,
  INTERNAL_CONNECTION_SETTING_NAME,
  PAT_RERESTRICT_NOTE,
  patRestrictionHelp,
  internalConnectionRestrictionHelp,
} from "../src/wizard/admin-settings.ts";

describe("patRestrictionHelp", () => {
  const msg = patRestrictionHelp();

  test("names the exact setting, its location, and who can change it", () => {
    expect(msg).toContain(PAT_SETTING_NAME);
    expect(msg).toContain(ADMIN_CONNECTIONS_PATH);
    expect(msg.toLowerCase()).toContain("admin");
  });

  test("mentions that the PAT setting can be re-restricted after setup", () => {
    expect(msg).toContain(PAT_RERESTRICT_NOTE);
    expect(msg.toLowerCase()).toContain("re-restrict");
  });

  test("does not leak the other setting's name", () => {
    expect(msg).not.toContain(INTERNAL_CONNECTION_SETTING_NAME);
  });
});

describe("internalConnectionRestrictionHelp", () => {
  const msg = internalConnectionRestrictionHelp();

  test("names the exact setting, its location, and who can change it", () => {
    expect(msg).toContain(INTERNAL_CONNECTION_SETTING_NAME);
    expect(msg).toContain(ADMIN_CONNECTIONS_PATH);
    expect(msg.toLowerCase()).toContain("admin");
  });
});
