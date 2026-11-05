export const BRAND = {
  name: "Ternway",
  tagline: "Your machines. One workspace.",
  author: "Mohamed Elashri",
  source: "https://github.com/MohamedElashri/ternway",
  issues: "https://github.com/MohamedElashri/ternway/issues",
  releases: "https://github.com/MohamedElashri/ternway/releases",
  license: "https://github.com/MohamedElashri/ternway/blob/main/LICENSE",
} as const;

export interface BuildMetadata {
  version: string;
  os: string;
  arch: string;
  commit: string;
  debug: boolean;
}

/** Deliberately limited to build data; never include profiles, paths or credentials. */
export function buildSummary(metadata: BuildMetadata): string {
  return [
    `${BRAND.name} ${metadata.version}`,
    `Platform: ${metadata.os} / ${metadata.arch}`,
    `Build: ${metadata.debug ? "development" : "release"}`,
    `Commit: ${metadata.commit || "unavailable"}`,
  ].join("\n");
}
