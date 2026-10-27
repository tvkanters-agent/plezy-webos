// SPDX-License-Identifier: GPL-3.0-only
// Match Plezy's MediaItem.displayTitle / MediaCard.buildMetadataSubtitle:
// an episode card names its SERIES and captions it "S# E# · Episode title".
// This is a presentation-only mapping: playback/detail metadata keeps the
// episode's actual title and ID.
function indexNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
export function cardLabels(item) {
  if (item.type !== 'episode' && item.type !== 'Episode')
    return {title:item.title, subtitle:item.subtitle};
  const raw = item.raw || {};
  const series = raw.grandparentTitle || raw.SeriesName || '';
  const season = indexNumber(raw.parentIndex ?? raw.ParentIndexNumber);
  const episode = indexNumber(raw.index ?? raw.IndexNumber);
  const number = season === null ? '' : 'S' + season + (episode === null ? '' : ' E' + episode);
  return {
    title: series || item.title,
    subtitle: number ? number + ' · ' + item.title : (series ? item.title : item.subtitle)
  };
}
