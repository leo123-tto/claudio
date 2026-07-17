export function resolveAirPlayMode({ webkitPicker = false } = {}) {
  const browserPicker = Boolean(webkitPicker);
  return {
    visible: browserPicker,
    nativePicker: false,
    webkitPicker: browserPicker,
    directMedia: browserPicker,
  };
}
