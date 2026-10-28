// Responsive household controls, with fixed room targets independent of the Pi helper.
import { buildHomeCards, PLAYERS, DENON, TV } from './dashboard.mjs';

const section = (title, cards) => ({ type: 'grid', cards: [{ type: 'heading', heading: title }, ...cards] });
const navigate = (name, path) => ({ type: 'button', name, icon: 'mdi:arrow-right', tap_action: { action: 'navigate', navigation_path: path } });

export function buildHouseholdDashboard() {
  const home = buildHomeCards();
  return {
    title: 'Home', swipe_nav: { enable: false },
    views: [
      {
        title: 'Home', icon: 'mdi:home', type: 'sections', max_columns: 3,
        sections: [
          section('Living room · Receiver', [
            { type: 'media-control', entity: DENON },
            { type: 'tile', entity: DENON, name: 'Receiver controls', grid_options: { columns: 12 }, features: [
              { type: 'media-player-volume-slider' }, { type: 'media-player-source' }, { type: 'media-player-sound-mode' },
            ] }, home[3].cards.at(-1),
          ]),
          section('Living room · TV', [
            { type: 'tile', entity: TV, name: 'LG TV', grid_options: { columns: 12 }, features: [{ type: 'media-player-volume-slider' }] },
            home[4].cards[2],
          ]),
          section('Entry', [
            { type: 'tile', entity: 'lock.lock_ultra_17', name: 'Front door', features: [{ type: 'lock-commands' }] },
            { type: 'tile', entity: 'sensor.lock_ultra_17_battery', name: 'Lock battery' },
          ]),
          section('Office · Aquarium', home[1].cards.slice(1)),
          section('Living room · Camera', [
            ...home[2].cards.slice(1), navigate('Open camera', '/dashboard-cameras/0'),
          ]),
          section('More', [navigate('Music rooms', '/dashboard-new/music'), navigate('UPS', '/dashboard-new/ups'), navigate('Map', '/map')]),
        ],
      },
      {
        title: 'Music', path: 'music', icon: 'mdi:music', type: 'sections', max_columns: 3,
        sections: [
          ...PLAYERS.map(player => section(player.name, [{ type: 'media-control', entity: player.entity }])),
          section('Music services', [
            { type: 'tile', entity: 'media_player.spotifyplus_gabi', name: 'Spotify', features: [{ type: 'media-player-source' }] },
            navigate('Open Music Assistant', '/d5369777_music_assistant'),
          ]),
        ],
      },
      {
        title: 'UPS', path: 'ups', icon: 'mdi:power-plug-battery', type: 'sections', max_columns: 2,
        sections: [section('UPS', [
          { type: 'tile', entity: 'sensor.ups_apc_status', name: 'Status' },
          { type: 'tile', entity: 'sensor.ups_apc_battery_charge', name: 'Battery charge' },
          { type: 'tile', entity: 'sensor.ups_apc_load', name: 'Load' },
          { type: 'tile', entity: 'sensor.ups_apc_input_voltage', name: 'Input voltage' },
          { type: 'tile', entity: 'sensor.ups_battery_runtime', name: 'Battery runtime' },
          { type: 'tile', entity: 'sensor.ups_battery_voltage', name: 'Battery voltage' },
        ])],
      },
    ],
  };
}

export function buildCameraDashboard(original) {
  if (original.views?.length !== 1 || original.views[0].sections?.length !== 2) throw new Error('Review the changed camera layout before cleanup');
  const result = structuredClone(original);
  const first = result.views[0].sections[0];
  const maintenance = first.cards.filter(card => card.type === 'vertical-stack');
  if (maintenance.length !== 1 || !first.cards.some(card => card.type === 'custom:webrtc-camera')) throw new Error('Expected the existing camera and saved-position controls');
  first.cards = [
    ...first.cards.filter(card => card.type !== 'vertical-stack'),
    ...buildHomeCards()[2].cards.slice(1),
    navigate('Saved camera positions', '/dashboard-cameras/positions'),
  ];
  result.views[0].sections = [first];
  result.views.push({ title: 'Saved camera positions', path: 'positions', subview: true, type: 'sections', sections: [section('Saved positions', maintenance)] });
  result.swipe_nav = { enable: false };
  return result;
}

export function entityReferences(value) {
  const result = new Set();
  function visit(item, key) {
    if (['service', 'perform_action'].includes(key)) return;
    if (typeof item === 'string') {
      for (const match of item.matchAll(/\b(?:media_player|lock|switch|sensor|number|camera)\.[a-z0-9_]+\b/g)) result.add(match[0]);
    } else if (item && typeof item === 'object') Object.entries(item).forEach(([childKey, child]) => visit(child, childKey));
  }
  visit(value);
  return result;
}
