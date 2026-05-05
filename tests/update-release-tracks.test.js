import { describe, expect, test } from 'vitest';
import {
  addMissingMajorTracks,
  latestBookwormTagsByMajor,
  parseBookwormTag
} from '../scripts/update-release-tracks.js';

describe('update-release-tracks', () => {
  test('parses PostgreSQL bookworm minor tags', () => {
    expect(parseBookwormTag('19.2-bookworm')).toEqual({
      tag: '19.2-bookworm',
      major: '19',
      minor: 2
    });
    expect(parseBookwormTag('19-bookworm')).toBeUndefined();
    expect(parseBookwormTag('19.2-alpine')).toBeUndefined();
  });

  test('selects latest bookworm minor per major', () => {
    expect(latestBookwormTagsByMajor([
      '18.1-bookworm',
      '18.3-bookworm',
      '19.1-bookworm',
      '19.0-bookworm',
      '20-alpine'
    ])).toEqual([
      { tag: '18.3-bookworm', major: '18', minor: 3 },
      { tag: '19.1-bookworm', major: '19', minor: 1 }
    ]);
  });

  test('adds only majors newer than the highest existing track', () => {
    const result = addMissingMajorTracks({
      tracks: [
        { major: '17', minor: '17.9', base: 'postgres:17.9-bookworm@sha256:old' },
        { major: '18', minor: '18.3', base: 'postgres:18.3-bookworm@sha256:current' }
      ]
    }, [
      { tag: '16.10-bookworm', major: '16', minor: 10, digest: 'sha256:ignored' },
      { tag: '19.1-bookworm', major: '19', minor: 1, digest: 'sha256:new' }
    ]);

    expect(result.changed).toBe(true);
    expect(result.releaseTracks.tracks).toEqual([
      { major: '17', minor: '17.9', base: 'postgres:17.9-bookworm@sha256:old' },
      { major: '18', minor: '18.3', base: 'postgres:18.3-bookworm@sha256:current' },
      { major: '19', minor: '19.1', base: 'postgres:19.1-bookworm@sha256:new' }
    ]);
  });
});
