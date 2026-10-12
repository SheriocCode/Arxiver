// Assignable tag colors (Zotero-style). Stored per tag as a hex string, so there is
// no limit on how many distinct colors you can use. The presets are quick shortcuts;
// the picker also offers a full color wheel for any color.
export const TAG_PRESETS = [
  "#e0564f", "#e08a3c", "#d9b23c", "#4caf50", "#10a37f",
  "#4c9aff", "#6b7ae1", "#a06be1", "#e0679a", "#8a8a8a"
];

export function tagColor(color?: string): string {
  return color || "var(--faint)";
}
