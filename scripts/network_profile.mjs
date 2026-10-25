import { readFileSync } from "node:fs";

export const networkProfile = JSON.parse(readFileSync(new URL("../assets/network_profile.json", import.meta.url), "utf8"));
export const networks = networkProfile.networks;
export const defaultNetwork = networks[networkProfile.defaultNetwork];
