// Sanitized HA configuration. No access tokens, custom-card code, or device calls.
export const PLAYER_HELPER = 'input_select.pi_console_player';
export const TRANSFER_HELPER = 'input_select.pi_console_transfer_source';
export const PLAYERS = Object.freeze([
  { entity: 'media_player.denon_avc_x4700h_3', name: 'Denon AVC-X4700H' },
  { entity: 'media_player.bedroom_3', name: 'Bedroom · WiiM Ultra' },
  { entity: 'media_player.lg_tv_oled83c_2', name: 'Living room · LG TV' },
  { entity: 'media_player.shield_3', name: 'SHIELD' },
]);
export const RADIO = Object.freeze([
  { name: 'Radio Paradise', uri: 'library://radio/52' },
  { name: 'Mellow Mix', uri: 'library://radio/53' },
  { name: 'Global Mix', uri: 'library://radio/50' },
  { name: 'Beyond…', uri: 'library://radio/49' },
]);
export const RECEIVER_RADIO = Object.freeze([
  ...RADIO,
  { name: 'Rock Mix', uri: 'library://radio/54' },
  { name: 'Serenity', uri: 'library://radio/55' },
]);
export const DENON = 'media_player.denon_avc_x4700h';
export const TV = 'media_player.lg_webos_tv_oled83c36la';
export function buildTvWakeAutomation(wakeButton) {
  if (!/^button\.wake_on_lan_[a-z0-9_]+$/.test(wakeButton)) throw new Error('Specify the verified TV Wake-on-LAN button');
  return {
    alias: 'Home Console · LG TV wake',
    description: 'Send Wake-on-LAN only after an explicit native TV turn-on request.',
    mode: 'single', max_exceeded: 'silent',
    triggers: [{ trigger: 'webostv.turn_on', entity_id: TV }],
    conditions: [],
    actions: [{ action: 'button.press', target: { entity_id: wakeButton } }],
  };
}
const TV_SOURCES = [
  ['PC', 'HDMI 1'], ['SHIELD', 'SHIELD Game Console'],
  ['Denon', 'Denon Sound Bar'], ['YouTube', 'YouTube'],
  ['Plex', 'Plex'], ['Netflix', 'Netflix'], ['Apple TV', 'Apple TV'],
];

function markdown(content) { return { type: 'markdown', content }; }
function stack(cards) { return { type: 'vertical-stack', cards }; }
function grid(cards, columns = 2) { return { type: 'grid', columns, square: false, cards }; }
function tile(entity, name) {
  return { type: 'tile', entity, name, ...(entity.startsWith('switch.') ? { tap_action: { action: 'toggle' } } : {}) };
}
function actionButton(name, action, data = {}, target) {
  return {
    type: 'button', name, show_state: false,
    tap_action: { action: 'perform-action', perform_action: action, data, ...(target ? { target: { entity_id: target } } : {}) },
    hold_action: { action: 'none' },
  };
}
function roomSelector() {
  return { type: 'entities', show_header_toggle: false, entities: [{ entity: PLAYER_HELPER, name: 'Control room' }] };
}
function selectedCards(factory) {
  return PLAYERS.map(player => ({
    type: 'conditional',
    conditions: [{ condition: 'state', entity: PLAYER_HELPER, state: player.entity }],
    card: factory(player),
  }));
}
export const DETAILS_ACTIONS = Object.freeze({
  tap_action: { action: 'more-info' }, icon_tap_action: { action: 'more-info' },
  hold_action: { action: 'none' }, double_tap_action: { action: 'none' },
  icon_hold_action: { action: 'none' }, icon_double_tap_action: { action: 'none' },
});
export function playerDetailsTile(player) {
  return { ...tile(player.entity, player.name), ...structuredClone(DETAILS_ACTIONS) };
}
function volumeCard(entity, name, sliderOnly = false, hideMute = true) {
  const card = { ...tile(entity, name), features: [{ type: 'media-player-volume-slider' }] };
  return {
    type: 'conditional',
    conditions: ['off', 'unknown', 'unavailable'].map(state => ({ condition: 'state', entity, state_not: state })),
    card: sliderOnly ? { type: 'custom:home-console-volume-slider', hide_mute: hideMute, card } : card,
  };
}
function libraryCard(player, configEntryId, radio = false) {
  return {
    type: 'conditional',
    // A missing HA entity must not let the third-party card fall back to all players.
    conditions: ['unknown', 'unavailable'].map(state => ({ condition: 'state', entity: player.entity, state_not: state })),
    card: {
      type: 'custom:ma-browser-card', config_entry_id: configEntryId,
      ma_addon_slug: 'd5369777_music_assistant',
      players: [player.entity], default_player: player.entity,
      auto_follow: false, use_app_area: false, show_all_playing_players: false,
      height: radio ? 300 : 430, sidebar_position: 'top', show_title: false, click_action: 'browse',
      ...(radio ? { home_order: ['radio'], home_sections: { radio: 100, recently_played: 0, recently_added: 0, discover: 0 } } : {}),
    },
  };
}
function sourceButtons(entity, script, sources) {
  return grid([
    actionButton('Off', 'media_player.turn_off', {}, entity),
    ...sources.map(([label, source]) => actionButton(label, `script.${script}`, { source })),
  ], 3);
}

export function denonSourceButtons({ includeHeos = true, includeTv = true } = {}) {
  const available = `states('${DENON}') not in ['off', 'unknown', 'unavailable']`;
  const buttons = [
    [actionButton('Off', 'media_player.turn_off', {}, DENON), `is_state('${DENON}', 'off')`],
    [actionButton('TV', 'script.home_console_denon_source', { source: 'TV Audio' }), `${available} and state_attr('${DENON}', 'source') == 'TV Audio'`],
    [actionButton('HEOS', 'script.home_console_denon_source', { source: 'HEOS Music' }), `${available} and state_attr('${DENON}', 'source') in ['HEOS Music', 'NET']`],
  ];
  const selected = buttons.filter(([button]) => (includeHeos || button.name !== 'HEOS') && (includeTv || button.name !== 'TV'));
  return highlightedSourceButtons(selected, selected.length);
}

export function receiverRadioButtons(stations = RECEIVER_RADIO) {
  return grid(stations.map(station => ({
    type: 'custom:home-console-active-button', active: false,
    tooltip: station.name,
    card: { ...actionButton(station.name, 'music_assistant.play_media', {
      media_id: station.uri, media_type: 'radio', enqueue: 'replace',
    }, PLAYERS[0].entity), show_icon: false },
  })), 3);
}

export function tvSourceButtons() {
  const available = `states('${TV}') not in ['off', 'unknown', 'unavailable']`;
  return highlightedSourceButtons([
    [actionButton('Off', 'media_player.turn_off', {}, TV), `is_state('${TV}', 'off')`],
    ...TV_SOURCES.map(([label, source]) => [
      actionButton(label, 'script.home_console_tv_source', { source }),
      `${available} and state_attr('${TV}', 'source') == '${source}'`,
    ]),
  ], 8);
}

function highlightedSourceButtons(buttons, columns = 3) {
  const icons = {
    Off: 'mdi:power', TV: 'mdi:television', HEOS: 'mdi:cast-audio',
    PC: 'mdi:desktop-classic', SHIELD: 'mdi:shield', Denon: 'mdi:audio-video',
    YouTube: 'mdi:youtube', Plex: 'mdi:plex', Netflix: 'mdi:netflix', 'Apple TV': 'mdi:apple',
  };
  buttons = buttons.map(([button, active]) => [{ ...button, icon: icons[button.name], show_name: false, show_icon: true, icon_height: '28px' }, active]);
  const colors = {
    Off: '#ef5350', TV: '#42a5f5', HEOS: '#26c6da', PC: '#90caf9',
    SHIELD: '#76b900', Denon: '#ffb74d', YouTube: '#ff0000',
    Plex: '#e5a00d', Netflix: '#e50914', 'Apple TV': '#f5f5f5',
  };
  const tooltips = {
    Off: 'Выключить', TV: 'Звук телевизора', HEOS: 'Музыка HEOS',
    PC: 'Компьютер', SHIELD: 'NVIDIA SHIELD', Denon: 'Ресивер Denon',
    YouTube: 'YouTube', Plex: 'Plex', Netflix: 'Netflix', 'Apple TV': 'Apple TV',
  };
  const wrapped = (button, active) => ({ type: 'custom:home-console-active-button', active, ...(button.name === 'SHIELD' ? { logo: 'nvidia' } : {}), icon_color: colors[button.name], tooltip: tooltips[button.name], card: button });
  return grid(buttons.map(([button, active]) => stack([
    { type: 'conditional', conditions: [{ condition: 'template', value_template: `{{ ${active} }}` }], card: wrapped(button, true) },
    { type: 'conditional', conditions: [{ condition: 'template', value_template: `{{ not (${active}) }}` }], card: wrapped(button, false) },
  ])), columns);
}

export function wakeAndSelect(entity, sources, alias) {
  return {
    alias, mode: 'restart', max_exceeded: 'silent',
    description: 'Explicit source tap only. Refuse unknown/unavailable devices; wait at most 30 seconds after wake.',
    fields: { source: { required: true, selector: { select: { options: sources } } } },
    sequence: [
      { condition: 'template', value_template: `{{ states('${entity}') not in ['unknown', 'unavailable'] and source in ${JSON.stringify(sources)} }}` },
      { if: [{ condition: 'state', entity_id: entity, state: 'off' }], then: [
        // AVR ignores a wake sent during its just-entered standby transition.
        ...(entity === DENON ? [{ delay: '00:00:05' }] : []),
        { action: 'media_player.turn_on', target: { entity_id: entity } },
      ] },
      { wait_template: `{{ states('${entity}') not in ['off', 'unknown', 'unavailable'] and source in (state_attr('${entity}', 'source_list') or []) }}`, timeout: '00:00:30', continue_on_timeout: false },
      { action: 'media_player.select_source', target: { entity_id: entity }, data: { source: '{{ source }}' } },
    ],
  };
}

export function withTvReceiverAudio(script) {
  const select = script.sequence?.at(-1);
  if (select?.action !== 'media_player.select_source' || select.target?.entity_id !== TV) {
    throw new Error('Expected the TV source selection as the last action');
  }
  return { ...structuredClone(script), sequence: [...structuredClone(script.sequence),
    { action: 'script.home_console_denon_source', data: { source: 'TV Audio' } }, {
    if: [{ condition: 'template', value_template: `{{ state_attr('${TV}', 'sound_output') != 'external_arc' }}` }],
    then: [
      { action: 'webostv.select_sound_output', data: { entity_id: TV, sound_output: 'external_arc' } },
      { wait_template: `{{ state_attr('${TV}', 'sound_output') == 'external_arc' }}`, timeout: '00:00:10', continue_on_timeout: false },
    ],
  }] };
}

export function receiverRadioPlayback() {
  const player = PLAYERS[0].entity;
  return {
    alias: 'Home Console · Receiver radio', mode: 'restart', max_exceeded: 'silent',
    description: 'Every explicit station tap wakes Denon, selects HEOS and replaces playback, including repeated taps.',
    fields: { media_id: { required: true, selector: { text: {} } } },
    sequence: [
      { if: [{ condition: 'template', value_template: `{{ media_id is not string or not (media_id | regex_match('^library://radio/[0-9]+$')) or states('${DENON}') in ['unknown', 'unavailable'] }}` }],
        then: [{ stop: 'Radio station or Denon is unavailable.', error: true }] },
      { action: 'script.home_console_denon_source', data: { source: 'HEOS Music' } },
      { wait_template: `{{ states('${DENON}') not in ['off', 'unknown', 'unavailable'] and state_attr('${DENON}', 'source') in ['HEOS Music', 'NET'] and states('${player}') not in ['unknown', 'unavailable'] }}`, timeout: '00:00:20', continue_on_timeout: false },
      { action: 'music_assistant.play_media', target: { entity_id: player },
        data: { media_id: '{{ media_id }}', media_type: 'radio', enqueue: 'replace' } },
    ],
  };
}

export function buildScripts() {
  const entities = JSON.stringify(PLAYERS.map(player => player.entity));
  const selected = `states('${PLAYER_HELPER}')`;
  const source = `states('${TRANSFER_HELPER}')`;
  return {
    home_console_receiver_radio: receiverRadioPlayback(),
    home_console_denon_source: wakeAndSelect(DENON, ['TV Audio', 'HEOS Music'], 'Home Console · Denon source'),
    home_console_tv_source: withTvReceiverAudio(wakeAndSelect(TV, TV_SOURCES.map(([, value]) => value), 'Home Console · LG TV source')),
    home_console_radio: {
      alias: 'Home Console · Radio favorite', mode: 'single',
      fields: { media_id: { required: true, selector: { select: { options: RADIO.map(station => station.uri) } } } },
      sequence: [
        { variables: { selected_player: `{{ ${selected} }}` } },
        { condition: 'template', value_template: `{{ selected_player in ${entities} and states(selected_player) not in ['unknown', 'unavailable'] and media_id in ${JSON.stringify(RADIO.map(station => station.uri))} }}` },
        { action: 'music_assistant.play_media', target: { entity_id: '{{ selected_player }}' }, data: { media_id: '{{ media_id }}', media_type: 'radio', enqueue: 'replace' } },
      ],
    },
    home_console_transfer: {
      alias: 'Home Console · Transfer playback to room', mode: 'single',
      description: 'Move the explicitly selected source queue to the console control room. Never runs on room selection.',
      sequence: [
        { variables: { selected_player: `{{ ${selected} }}`, source_player: `{{ ${source} }}` } },
        { if: [{ condition: 'template', value_template: `{{ not (selected_player in ${entities} and source_player in ${entities} and selected_player != source_player and states(selected_player) not in ['unknown', 'unavailable'] and states(source_player) in ['playing', 'paused'] and state_attr(source_player, 'active_queue')) }}` }],
          then: [{ stop: 'Choose different available MA rooms and a source playing or pausing an active MA queue.', error: true }] },
        { action: 'music_assistant.transfer_queue', target: { entity_id: '{{ selected_player }}' }, data: { source_player: '{{ source_player }}', auto_play: true } },
      ],
    },
  };
}

export function buildHomeCards({ sourceIndicators = false } = {}) {
  return [
    // The user requested the native details popup. Card/icon taps never toggle the lock.
    { ...tile('lock.lock_ultra_17', 'Lock Ultra 17'),
      tap_action: { action: 'more-info' }, icon_tap_action: { action: 'more-info' },
      hold_action: { action: 'none' }, double_tap_action: { action: 'none' },
      icon_hold_action: { action: 'none' }, icon_double_tap_action: { action: 'none' } },
    tile('switch.power_plug_cd43', 'Aquarium outlet'),
    stack([grid([
      tile('switch.chuangmi_sg_1069362690_039c04_on_p_2_1', 'Camera power'),
      tile('switch.chuangmi_sg_1069362690_039c04_motion_detection_p_5_1', 'Motion detection'),
      tile('switch.chuangmi_sg_1069362690_039c04_human_tracking_p_2_9', 'Human tracking'),
    ], 3)]),
    stack([volumeCard(DENON, 'Denon volume'), sourceIndicators ? denonSourceButtons() : sourceButtons(DENON, 'home_console_denon_source', [['TV', 'TV Audio'], ['HEOS', 'HEOS Music']])]),
    stack([tile(TV, 'Living-room LG TV'), sourceIndicators ? tvSourceButtons() : sourceButtons(TV, 'home_console_tv_source', TV_SOURCES)]),
  ];
}

export function buildDashboard({ runtimeEntity = 'sensor.ups_battery_runtime', voltageEntity = 'sensor.ups_battery_voltage', music = false, navigation = false, configEntryId, queuePlayerMap } = {}) {
  if (music && !configEntryId) throw new Error('The music candidate needs the verified MA config entry ID');
  const view = (title, path, icon, cards) => ({ title, path, icon, panel: true, cards: [stack(cards)] });
  const pending = markdown('**Implementation in progress.** Full library search and queue control await the approved music component and kiosk-user feasibility test. This dashboard is not ready for Pi cutover.');
  const homeCards = buildHomeCards({ sourceIndicators: true });
  const dashboard = {
    title: 'Home Console',
    ...(navigation ? { swipe_nav: { enable: true, wrap: true, swipe_amount: 25, prevent_default: true, enable_mouse_swipe: false } } : {}),
    views: [
      view('UPS', 'ups', 'mdi:power-plug-battery', [
        markdown("## UPS\n{{ device_attr('sensor.ups_apc_status', 'manufacturer') or 'Unknown manufacturer' }} · {{ device_attr('sensor.ups_apc_status', 'model') or 'Unknown model' }}<br>Status: **{{ states('sensor.ups_apc_status') }}** · NUT: **{{ states('sensor.ups_apc_status_data') }}**"),
        grid([
          tile('sensor.ups_apc_battery_charge', 'Battery charge'), tile('sensor.ups_apc_load', 'Load'),
          tile('sensor.ups_apc_input_voltage', 'Input voltage'), tile(runtimeEntity, 'Battery runtime'),
          tile(voltageEntity, 'Battery voltage'),
        ], 3),
      ]),
      view('Home', 'home', 'mdi:home', [{
        type: 'custom:home-console-door-card',
        card: { ...homeCards[0], name: 'Front door', features: [{ type: 'lock-commands' }] },
        battery: tile('sensor.lock_ultra_17_battery', 'Lock battery'),
      }, homeCards[1], homeCards[2]]),
      view('TV', 'tv', 'mdi:television', [{ type: 'custom:home-console-tv-layout', card: {
        ...homeCards[4], cards: [homeCards[4].cards[0], { ...homeCards[4].cards[1], columns: 4 }],
      } }]),
      view('Receiver', 'receiver', 'mdi:audio-video', [{ type: 'custom:home-console-receiver-layout', card: stack([
        { type: 'media-control', entity: PLAYERS[0].entity },
        volumeCard(DENON, 'Denon volume', true, false), denonSourceButtons({ includeHeos: false, includeTv: false }),
        { type: 'custom:home-console-radio-favorites', player: PLAYERS[0].entity },
      ]) }]),
      view('Music Library', 'music-library', 'mdi:music-box-multiple', [roomSelector(), ...(music ? [
        markdown(`Selected player: **{{ state_attr(states('${PLAYER_HELPER}'), 'friendly_name') or states('${PLAYER_HELPER}') }}** · **{{ states(states('${PLAYER_HELPER}')) }}**`),
        ...selectedCards(player => libraryCard(player, configEntryId)),
        ...(queuePlayerMap ? [{ type: 'custom:home-console-queue', player_helper: PLAYER_HELPER, player_map: queuePlayerMap }] : []),
      ] : [pending])]),
      view('Players', 'players', 'mdi:speaker-multiple', [
        roomSelector(),
        // User-approved: tiles open the native player details (volume, mute, grouping); no single tap sends a command.
        grid(PLAYERS.map(player => playerDetailsTile(player))),
        ...selectedCards(player => ({ type: 'media-control', entity: player.entity })),
        ...selectedCards(player => volumeCard(player.entity, `Volume · ${player.name}`)),
        { type: 'entities', show_header_toggle: false, entities: [{ entity: TRANSFER_HELPER, name: 'Transfer from room' }] },
        { ...actionButton('Transfer playback to room', 'script.home_console_transfer'), tap_action: {
          ...actionButton('', 'script.home_console_transfer').tap_action,
          confirmation: { text: 'Move the active queue from Transfer from room to Control room?' },
        } },
        markdown('Changing Control room leaves existing playback in its original room. Transfer is a separate action; choose both rooms first.'),
      ]),
      view('Internet Radio', 'radio', 'mdi:radio', [
        roomSelector(), grid(RADIO.map(station => actionButton(station.name, 'script.home_console_radio', { media_id: station.uri }))),
        ...(music ? selectedCards(player => libraryCard(player, configEntryId, true)) : [pending]),
      ]),
    ],
  };
  for (const view of dashboard.views) {
    if (view.path === 'home') {
      view.cards = [{ type: 'custom:home-console-home-layout', card: view.cards[0] }];
    }
    if (['music-library', 'players', 'radio'].includes(view.path)) {
      view.visible = false;
    }
  }
  return dashboard;
}
