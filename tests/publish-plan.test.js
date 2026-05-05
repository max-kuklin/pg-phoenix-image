import { describe, expect, test } from 'vitest';
import {
  baseDigestShort,
  buildPublishPlan,
  changedTracks,
  parseTrackList,
  releaseTags,
  upgradePairsForTracks
} from '../scripts/resolve-publish-plan.js';

const tracks = [
  {
    major: '16',
    minor: '16.13',
    base: 'postgres:16.13-bookworm@sha256:aaaaaaaaaaaa0000000000000000000000000000000000000000000000000000'
  },
  {
    major: '17',
    minor: '17.9',
    base: 'postgres:17.9-bookworm@sha256:bbbbbbbbbbbb0000000000000000000000000000000000000000000000000000'
  },
  {
    major: '18',
    minor: '18.3',
    base: 'postgres:18.3-bookworm@sha256:cccccccccccc0000000000000000000000000000000000000000000000000000'
  }
];

describe('publish plan', () => {
  test('selects all tracks by default', () => {
    expect(parseTrackList('all', tracks).map((track) => track.major)).toEqual(['16', '17', '18']);
    expect(parseTrackList(undefined, tracks).map((track) => track.major)).toEqual(['16', '17', '18']);
  });

  test('selects requested tracks', () => {
    expect(parseTrackList('17,18', tracks).map((track) => track.major)).toEqual(['17', '18']);
  });

  test('detects changed and added track bases', () => {
    const previous = [
      tracks[0],
      {
        ...tracks[1],
        base: 'postgres:17.8-bookworm@sha256:dddddddddddd0000000000000000000000000000000000000000000000000000'
      }
    ];

    expect(changedTracks(previous, tracks).map((track) => track.major)).toEqual(['17', '18']);
  });

  test('builds immutable and moving tags', () => {
    expect(releaseTags(tracks[1], 'v0.4.0', '1234567890abcdef').immutable).toEqual([
      '17.9-v0.4.0-base-bbbbbbbbbbbb',
      '17.9-v0.4.0-sha-1234567890ab'
    ]);
    expect(releaseTags(tracks[1], 'v0.4.0', '1234567890abcdef').moving).toEqual([
      '17',
      '17.9',
      '17-v0.4.0'
    ]);
  });

  test('fails when a base is not digest pinned', () => {
    expect(() => baseDigestShort('postgres:17.9-bookworm')).toThrow('missing a sha256 digest');
  });

  test('selects adjacent upgrade pairs that include selected tracks', () => {
    expect(upgradePairsForTracks([tracks[1]], tracks)).toEqual([
      { oldMajor: '16', newMajor: '17' },
      { oldMajor: '17', newMajor: '18' }
    ]);
  });

  test('builds plan for changed tracks only when previous manifest is provided', () => {
    const previous = {
      tracks: [
        tracks[0],
        {
          ...tracks[1],
          minor: '17.8',
          base: 'postgres:17.8-bookworm@sha256:dddddddddddd0000000000000000000000000000000000000000000000000000'
        },
        tracks[2]
      ]
    };

    const plan = buildPublishPlan({
      current: { tracks },
      previous,
      tracks: 'all',
      releaseTag: 'v0.4.0',
      releaseSha: '1234567890abcdef'
    });

    expect(plan.images.map((track) => track.major)).toEqual(['17']);
    expect(plan.upgradePairs).toEqual([
      { oldMajor: '16', newMajor: '17' },
      { oldMajor: '17', newMajor: '18' }
    ]);
  });
});
