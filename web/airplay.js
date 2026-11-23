export function resolveAirPlayMode({ webkitPicker = false, outputMenu = false, webAudio = false } = {}) {
  // 没有系统投放选择器时用我们自己的设备菜单，音轨保持直连系统输出。
  if (outputMenu && !webkitPicker) {
    return {
      visible: true,
      nativePicker: false,
      webkitPicker: false,
      directMedia: true,
      outputMenu: true,
    };
  }
  // 手动要求走 WebAudio（地址带 ?audio=webaudio）：音量走 GainNode，iPhone 上才能压低音乐；
  // 代价是没有投放按钮，锁屏能不能继续放要真机看。
  if (webAudio) {
    return {
      visible: false,
      nativePicker: false,
      webkitPicker: false,
      directMedia: false,
      outputMenu: false,
    };
  }
  const browserPicker = Boolean(webkitPicker);
  return {
    visible: browserPicker,
    nativePicker: false,
    webkitPicker: browserPicker,
    directMedia: browserPicker,
    outputMenu: false,
  };
}

// ?audio=webaudio / ?audio=direct 记住选择；不带参数就用上次的。
export function resolveAudioEngine(search = '', stored = '') {
  const asked = new URLSearchParams(search).get('audio');
  const value = asked === 'webaudio' || asked === 'direct' ? asked : stored;
  return value === 'webaudio' ? 'webaudio' : 'direct';
}
