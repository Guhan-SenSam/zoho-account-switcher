// Builds the harness gallery: one interactive iframe of the real popup per scenario.
const SCENARIOS = [
  ['list', 'Several accounts, one active'],
  ['list&click=menu@a2', 'Row menu open'],
  ['list&click=menu@a3,remove@a3', 'Confirm remove'],
  ['pending', 'Adding an account (sign-out mode)'],
  ['pending-first', 'Adding the first account (sign-out mode)'],
  ['private-pending', 'Adding in a private window'],
  ['private-closed-captured', 'Private window closed, sign-in saved'],
  ['private-closed', 'Private window closed, not signed in'],
  ['private-pending&fill=new-account-name=Client X&click=finish-add', 'Saved from private window (notice)'],
  ['incognito-off', 'Incognito not allowed (hint)'],
  ['no-active', 'No active account'],
  ['no-active&click=switch@a2', 'Confirm switch (unsaved session)'],
  ['empty', 'First run (no accounts)'],
  ['error', 'Error message'],
  ['warning', 'Switch warnings'],
  ['busy', 'Busy (op running elsewhere)'],
  ['many', 'Many accounts (scrolls)'],
  ['deep-clean-on', 'Deep clean on'],
];

const grid = document.getElementById('grid');
for (const [query, label] of SCENARIOS) {
  const src = `/extension/popup/popup.html?scenario=${query.replaceAll(' ', '%20')}`;
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption');
  const link = Object.assign(document.createElement('a'), { href: src, target: '_blank', textContent: 'open' });
  caption.append(label, link);
  const frame = Object.assign(document.createElement('iframe'), { src, title: label });
  figure.append(caption, frame);
  grid.append(figure);
}
