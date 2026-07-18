import { describe, expect, test } from 'bun:test';
import { rankCommands, scoreCommand, type SearchableCommand } from './commandSearch';

const COMMANDS: SearchableCommand[] = [
  { id: 'home', label: 'Go to Home' },
  { id: 'logs', label: 'Go to Logs' },
  { id: 'history', label: 'Jump to com.example.app in Job History', keywords: 'com.example.app' },
];

describe('scoreCommand', () => {
  test('prefers exact match over partial match', () => {
    const exact = scoreCommand(COMMANDS[1], 'go to logs', []);
    const partial = scoreCommand(COMMANDS[0], 'go to', []);
    expect(exact).toBeGreaterThan(partial);
  });

  test('uses recents when query is empty', () => {
    const recent = scoreCommand(COMMANDS[0], '', ['home']);
    const notRecent = scoreCommand(COMMANDS[1], '', ['home']);
    expect(recent).toBeGreaterThan(notRecent);
  });
});

describe('rankCommands', () => {
  test('matches keyword searches', () => {
    const ranked = rankCommands(COMMANDS, 'com.example', []);
    expect(ranked[0]?.id).toBe('history');
  });
});
