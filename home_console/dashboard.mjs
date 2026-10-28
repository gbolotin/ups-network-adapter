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
export const DENON = 'media_player.denon_avc_x4700h';
export const TV = 'media_player.lg_webos_tv_oled83c36la';
const TV_SOURCES = [
  ['PC · HDMI 1', 'HDMI 1'], ['SHIELD · HDMI 4', 'SHIELD Game Console'],
  ['Denon · HDMI 2', 'Denon Sound Bar'], ['YouTube', 'YouTube'],
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
function volumeCard(entity, name) {
  return {
    type: 'conditional',
    conditions: ['off', 'unknown', 'unavailable'].map(state => ({ condition: 'state', entity, state_not: state })),
    card: { ...tile(entity, name), features: [{ type: 'media-player-volume-slider' }] },
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

export function wakeAndSelect(entity, sources, alias) {
  return {
    alias, mode: 'restart', max_exceeded: 'silent',
    description: 'Explicit source tap only. Refuse unknown/unavailable devices; wait at most 30 seconds after wake.',
    fields: { source: { required: true, selector: { select: { options: sources } } } },
    sequence: [
      { condition: 'template', value_template: `{{ states('${entity}') not in ['unknown', 'unavailable'] and source in ${JSON.stringify(sources)} }}` },
      { if: [{ condition: 'state', entity_id: entity, state: 'off' }], then: [{ action: 'media_player.turn_on', target: { entity_id: entity } }] },
      { wait_template: `{{ states('${entity}') not in ['off', 'unknown', 'unavailable'] and source in (state_attr('${entity}', 'source_list') or []) }}`, timeout: '00:00:30', continue_on_timeout: false },
      { action: 'media_player.select_source', target: { entity_id: entity }, data: { source: '{{ source }}' } },
    ],
  };
}

export function buildScripts() {
  const entities = JSON.stringify(PLAYERS.map(player => player.entity));
  const selected = `states('${PLAYER_HELPER}')`;
  const source = `states('${TRANSFER_HELPER}')`;
  return {
    home_console_denon_source: wakeAndSelect(DENON, ['TV Audio', 'HEOS Music'], 'Home Console · Denon source'),
    home_console_tv_source: wakeAndSelect(TV, TV_SOURCES.map(([, value]) => value), 'Home Console · LG TV source'),
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

export function buildHomeCards() {
  return [
    // Markdown exposes no entity tap/hold control for the lock.
    markdown("## 1 · Lock Ultra 17\nState: **{{ states('lock.lock_ultra_17') }}**\n\nBattery: **{{ states('sensor.lock_ultra_17_battery') }}** {{ state_attr('sensor.lock_ultra_17_battery', 'unit_of_measurement') or '' }}"),
    stack([markdown('## 2 · Aquarium · Office'), grid([tile('switch.power_plug_cd43', 'Aquarium outlet'), tile('sensor.power_plug_cd43_power', 'Measured power')])]),
    stack([markdown('## 3 · Xiaomi C400 · Living room'), grid([
      tile('switch.chuangmi_sg_1069362690_039c04_on_p_2_1', 'Camera power'),
      tile('switch.chuangmi_sg_1069362690_039c04_motion_detection_p_5_1', 'Motion detection'),
      tile('switch.chuangmi_sg_1069362690_039c04_human_tracking_p_2_9', 'Human tracking'),
    ], 3)]),
    stack([markdown('## 4 · Denon AVC-X4700H'), { type: 'media-control', entity: DENON }, volumeCard(DENON, 'Denon volume'), sourceButtons(DENON, 'home_console_denon_source', [['TV', 'TV Audio'], ['HEOS', 'HEOS Music']])]),
    stack([markdown('## 5 · Living-room LG TV'), tile(TV, 'Living-room LG TV'), sourceButtons(TV, 'home_console_tv_source', TV_SOURCES)]),
  ];
}

export function buildDashboard({ runtimeEntity = 'sensor.ups_battery_runtime', voltageEntity = 'sensor.ups_battery_voltage', music = false, navigation = false, configEntryId, queuePlayerMap } = {}) {
  if (music && !configEntryId) throw new Error('The music candidate needs the verified MA config entry ID');
  const view = (title, path, icon, cards) => ({ title, path, icon, panel: true, cards: [stack(cards)] });
  const pending = markdown('**Implementation in progress.** Full library search and queue control await the approved music component and kiosk-user feasibility test. This dashboard is not ready for Pi cutover.');
  const nativePlayer = player => stack([{ type: 'media-control', entity: player.entity }, volumeCard(player.entity, `Volume · ${player.name}`)]);
  const dashboard = {
    title: 'Home Console',
    ...(navigation ? { swipe_nav: { enable: true, wrap: true, swipe_amount: 25, prevent_default: true, enable_mouse_swipe: false } } : {}),
    views: [
      view('UPS', 'ups', 'mdi:power-plug-battery', [
        markdown("## UPS\nStatus: **{{ states('sensor.ups_apc_status') }}** · NUT: **{{ states('sensor.ups_apc_status_data') }}**"),
        grid([
          tile('sensor.ups_apc_battery_charge', 'Battery charge'), tile('sensor.ups_apc_load', 'Load'),
          tile('sensor.ups_apc_input_voltage', 'Input voltage'), tile(runtimeEntity, 'Battery runtime'),
          tile(voltageEntity, 'Battery voltage'),
        ], 3),
      ]),
      view('Home', 'home', 'mdi:home', buildHomeCards()),
      view('Now Playing', 'now-playing', 'mdi:play-circle', [roomSelector(), ...selectedCards(nativePlayer)]),
      view('Music Library', 'music-library', 'mdi:music-box-multiple', [roomSelector(), ...(music ? [
        markdown(`Selected player: **{{ state_attr(states('${PLAYER_HELPER}'), 'friendly_name') or states('${PLAYER_HELPER}') }}** · **{{ states(states('${PLAYER_HELPER}')) }}**`),
        ...selectedCards(player => libraryCard(player, configEntryId)),
        ...(queuePlayerMap ? [{ type: 'custom:home-console-queue', player_helper: PLAYER_HELPER, player_map: queuePlayerMap }] : []),
      ] : [pending])]),
      view('Players', 'players', 'mdi:speaker-multiple', [
        roomSelector(),
        grid(PLAYERS.map(player => ({ ...tile(player.entity, player.name), tap_action: { action: 'none' }, hold_action: { action: 'none' }, icon_tap_action: { action: 'none' } }))),
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
  return dashboard;
}
