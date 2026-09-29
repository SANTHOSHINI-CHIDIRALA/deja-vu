// Two-series palette for the learning curve. Validated with the dataviz skill's
// validate_palette.js on the dark surface #0f141b: CVD ΔE 27.4, contrast >= 3:1.
export const SERIES = {
  off: { label: "Memory OFF", color: "#3987e5" },
  on: { label: "Memory ON", color: "#c98500" },
} as const;
