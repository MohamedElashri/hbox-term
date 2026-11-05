export const BRAND = {
  name: "Ternway",
  tagline: "Your machines. One workspace.",
  author: "Mohamed Elashri",
  source: "https://github.com/MohamedElashri/hbox-term",
  issues: "https://github.com/MohamedElashri/hbox-term/issues",
  releases: "https://github.com/MohamedElashri/hbox-term/releases",
  license: "https://github.com/MohamedElashri/hbox-term/blob/main/LICENSE",
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
