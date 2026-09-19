/** Stable BEM-style class hooks for embed customization (scope under `.vt-widget`). */
export const WIDGET_CSS_CLASSES = {
  root: "vt-widget",
  launcher: "vt-widget-launcher",
  panel: "vt-widget-panel",
  header: "vt-widget-header",
  close: "vt-widget-close",
  greeting: "vt-widget-greeting",
  status: "vt-widget-status",
  transcript: "vt-widget-transcript",
  msg: "vt-widget-msg",
  msgIncoming: "vt-widget-msg--incoming",
  msgOutgoing: "vt-widget-msg--outgoing",
  msgSystem: "vt-widget-msg--system",
  composer: "vt-widget-composer",
  input: "vt-widget-input",
  connect: "vt-widget-connect",
  micWarning: "vt-widget-mic-warning",
  playbackWarning: "vt-widget-playback-warning",
} as const;

export const WIDGET_CSS_VARIABLES = [
  "--vt-color-primary",
  "--vt-color-bg",
  "--vt-color-text",
  "--vt-font-ui",
  "--vt-font-size-ui",
  "--vt-font-incoming",
  "--vt-font-outgoing",
  "--vt-font-size-incoming",
  "--vt-font-size-outgoing",
  "--vt-bubble-incoming-bg",
  "--vt-bubble-incoming-fg",
  "--vt-bubble-outgoing-bg",
  "--vt-bubble-outgoing-fg",
  "--vt-header-bg",
  "--vt-input-bg",
  "--vt-input-fg",
  "--vt-panel-width",
  "--vt-panel-height",
  "--vt-panel-radius",
] as const;

export const WIDGET_CUSTOM_STYLE_ATTR = "data-vt-widget-custom";
