import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAY_NAMES,
  ScheduleError,
  createSchedule,
  isOpen,
  nextOpening,
  orderTasks,
  parseDays,
  parseTime,
  parseWindow,
  planRun,
} from '../src/schedule.js';
import { addTask, createQueue } from '../src/task-queue.js';

/** Date locale précise (aucun fuseau implicite dans les tests). */
const at = (day, hours, minutes = 0) => new Date(2026, 9, 5 + day, hours, minutes, 0, 0);
// 2026-10-05 est un lundi.

test('T-B-28 : motifs de jours et heures', () => {
  assert.deepEqual(parseDays('*'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays('lun-ven'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('sam,dim'), [0, 6]);
  assert.deepEqual(parseDays('ven-lun'), [0, 1, 5, 6], 'la plage traverse le week-end');
  assert.throws(() => parseDays('fête'), /jour inconnu/);
  assert.equal(parseTime('00:00'), 0);
  assert.equal(parseTime('23:59'), 1439);
  assert.throws(() => parseTime('24:30'), /hors limites/);
  assert.throws(() => parseTime('7h'), /heure invalide/);
  assert.equal(DAY_NAMES[1], 'lun');
});

test('T-B-28 : fenêtres, y compris celles qui traversent minuit', () => {
  assert.deepEqual(parseWindow('lun-ven 01:00-06:00'), {
    days: [1, 2, 3, 4, 5], start: 60, end: 360, wrap: false,
  });
  const night = parseWindow('* 22:00-02:00');
  assert.equal(night.wrap, true);
  assert.deepEqual(parseWindow({ days: [6], start: '10:00', end: '12:00' }).days, [6]);
  assert.throws(() => parseWindow('lun 06:00-06:00'), /fenêtre vide/);
  assert.throws(() => parseWindow('lundi'), /fenêtre invalide/);
});

test('T-B-28 : ouverture — fenêtre simple et fenêtre de nuit', () => {
  const schedule = createSchedule({ windows: ['lun-ven 01:00-06:00'] });
  assert.equal(isOpen(schedule, at(0, 0, 30)), false, 'lundi 00:30 : fermé');
  assert.equal(isOpen(schedule, at(0, 1, 0)), true, 'lundi 01:00 : ouvert');
  assert.equal(isOpen(schedule, at(0, 5, 59)), true);
  assert.equal(isOpen(schedule, at(0, 6, 0)), false, 'la fin est exclue');
  assert.equal(isOpen(schedule, at(5, 3, 0)), false, 'samedi : fermé');

  const nightSchedule = createSchedule({ windows: ['* 22:00-02:00'] });
  assert.equal(isOpen(nightSchedule, at(0, 23, 0)), true, 'lundi soir');
  assert.equal(isOpen(nightSchedule, at(1, 1, 30)), true, 'nuit de lundi à mardi');
  assert.equal(isOpen(nightSchedule, at(1, 3, 0)), false);
  assert.equal(isOpen(nightSchedule, at(0, 12, 0)), false);

  // Sans fenêtre : toujours ouvert (ne pas planifier n'est pas fermer).
  assert.equal(isOpen(createSchedule({}), at(0, 12, 0)), true);
  assert.equal(isOpen(null, at(0, 12, 0)), true);
});

test('T-B-28 : prochaine ouverture calculée au quart d’heure près', () => {
  const schedule = createSchedule({ windows: ['lun-ven 01:00-06:00'] });
  assert.equal(nextOpening(schedule, at(0, 0, 30)).getTime(), at(0, 1, 0).getTime());
  assert.equal(nextOpening(schedule, at(0, 3, 0)).getTime(), at(0, 3, 0).getTime(), 'déjà ouvert');
  // Vendredi 23:00 → lundi 01:00 (le week-end est fermé).
  const friday = at(4, 23, 0);
  const monday = nextOpening(schedule, friday);
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getHours(), 1);
  assert.ok(monday.getTime() - friday.getTime() <= 3 * 24 * 3600 * 1000);

  const never = createSchedule({ windows: ['lun 01:00-02:00'] });
  assert.ok(nextOpening(never, at(0, 3, 0)) instanceof Date, 'une fenêtre existe : elle revient');
  assert.equal(nextOpening(null, at(0, 3, 0)).getTime(), at(0, 3, 0).getTime());
});

test('T-B-28 : ordre des tâches — reprise, priorité, taille', () => {
  const tasks = [
    { id: 1, url: 'b', state: 'PENDING', totalSize: 500 },
    { id: 2, url: 'a', state: 'PAUSED', totalSize: 9000 },
    { id: 3, url: 'c', state: 'PENDING', totalSize: 100, priority: -1 },
    { id: 4, url: 'd', state: 'DONE', totalSize: 1 },
    { id: 5, url: 'e', state: 'FAILED', totalSize: 50 },
  ];
  const ordered = orderTasks(tasks);
  assert.deepEqual(ordered.map((task) => task.id), [2, 3, 1, 5, 4],
    'PAUSED, puis priorité -1, puis taille, puis échec, puis DONE en fin');
  assert.deepEqual(tasks.map((task) => task.id), [1, 2, 3, 4, 5], 'la file n’est pas modifiée');
  assert.deepEqual(orderTasks(tasks, { by: 'size' }).slice(0, 3).map((t) => t.id), [2, 3, 1]);
  assert.deepEqual(orderTasks(tasks, { by: 'url' }).map((t) => t.url).slice(0, 3), ['a', 'b', 'c']);
});

test('T-B-28 : plan d’exécution — hors fenêtre, quota d’octets et de tâches', () => {
  let queue = createQueue({});
  for (const [url, size] of [['http://h/a', 1000], ['http://h/b', 2000], ['http://h/c', -1], ['http://h/d', 500]]) {
    queue = addTask(queue, { url, target: `/tmp/${url.slice(-1)}`, totalSize: size }).queue;
  }

  const closed = createSchedule({ windows: ['lun-ven 01:00-06:00'] });
  const blocked = planRun({ queue, schedule: closed, now: at(0, 12, 0) });
  assert.equal(blocked.open, false);
  assert.deepEqual(blocked.selected, []);
  assert.equal(blocked.reason, 'hors fenêtre de planification');
  assert.equal(blocked.waitUntil.getHours(), 1);

  const open = createSchedule({ windows: [] });
  const full = planRun({ queue, schedule: open, now: at(0, 12, 0) });
  assert.equal(full.open, true);
  assert.equal(full.selected.length, 4);
  assert.equal(full.reason, 'prêt');

  // Quota d'octets : 1000 + 500 passent, 2000 dépasse, la taille inconnue est reportée.
  const budget = createSchedule({ windows: [], quota: { bytes: 1500 } });
  const limited = planRun({ queue, schedule: budget, now: at(0, 12, 0) });
  assert.deepEqual(limited.selected.map((task) => task.url), ['http://h/d', 'http://h/a']);
  // Ordre des candidats : 500 (d) puis 1000 (a) tiennent ; 2000 (b) dépasse ; la taille
  // inconnue (c) est reportée sans être devinée à zéro.
  assert.deepEqual(limited.skipped.map((task) => task.reason), [
    'quota d’octets atteint', 'taille inconnue : reportée',
  ]);

  const jobs = createSchedule({ windows: [], quota: { tasks: 2 } });
  const twoOnly = planRun({ queue, schedule: jobs, now: at(0, 12, 0) });
  assert.equal(twoOnly.selected.length, 2);
  assert.equal(twoOnly.skipped.length, 2);
  assert.equal(twoOnly.skipped[0].reason, 'quota de tâches atteint');
});

test('T-B-28 : quotas invalides refusés à la construction', () => {
  assert.throws(() => createSchedule({ quota: { bytes: -1 } }), (error) => error instanceof ScheduleError && error.code === 'BAD_QUOTA');
  assert.throws(() => createSchedule({ quota: { tasks: 1.5 } }), /quota de tâches invalide/);
  assert.deepEqual(createSchedule({ quota: {} }).quota, { bytes: null, tasks: null });
});
