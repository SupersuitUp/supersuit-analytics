import { homedir } from "node:os";
import { join } from "node:path";

export const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** `--app-dir`, then SUPERSUIT_ANALYTICS_DIR, then ~/.supersuit/analytics. */
export const defaultAppDir = () =>
  expandHome(process.env.SUPERSUIT_ANALYTICS_DIR || join(homedir(), ".supersuit", "analytics"));
