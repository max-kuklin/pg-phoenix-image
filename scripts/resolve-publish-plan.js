import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseTrackList(value, tracks) {
  if (!value || value === 'all') {
    return tracks;
  }

  const selected = new Set(value.split(',').map((track) => track.trim()).filter(Boolean));
  return tracks.filter((track) => selected.has(track.major));
}

export function changedTracks(previousTracks, currentTracks) {
  const previousByMajor = new Map(previousTracks.map((track) => [track.major, track]));

  return currentTracks.filter((track) => {
    const previous = previousByMajor.get(track.major);
    return !previous || previous.base !== track.base;
  });
}

export function baseDigestShort(base) {
  const match = /@sha256:([a-f0-9]{12})[a-f0-9]*/i.exec(base);

  if (!match) {
    throw new Error(`Base image is missing a sha256 digest: ${base}`);
  }

  return match[1].toLowerCase();
}

export function releaseTags(track, releaseTag, releaseSha) {
  const digest = baseDigestShort(track.base);
  const shortSha = releaseSha.slice(0, 12);

  return {
    immutable: [
      `${track.minor}-${releaseTag}-base-${digest}`,
      `${track.minor}-${releaseTag}-sha-${shortSha}`
    ],
    moving: [
      `${track.major}-${releaseTag}`,
      track.major,
      track.minor
    ]
  };
}

export function upgradePairsForTracks(selectedTracks, allTracks) {
  const selectedMajors = new Set(selectedTracks.map((track) => track.major));
  const sorted = [...allTracks].toSorted((a, b) => Number(a.major) - Number(b.major));
  const pairs = [];

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const oldTrack = sorted[index];
    const newTrack = sorted[index + 1];

    if (selectedMajors.has(oldTrack.major) || selectedMajors.has(newTrack.major)) {
      pairs.push({
        oldMajor: oldTrack.major,
        newMajor: newTrack.major
      });
    }
  }

  return pairs;
}

export function buildPublishPlan(options) {
  const allTracks = options.current.tracks;
  const selectedByInput = parseTrackList(options.tracks, allTracks);
  const selected = options.previous
    ? changedTracks(options.previous.tracks, selectedByInput)
    : selectedByInput;

  const images = selected.map((track) => ({
    ...track,
    releaseTag: options.releaseTag,
    releaseSha: options.releaseSha,
    baseDigestShort: baseDigestShort(track.base),
    tags: releaseTags(track, options.releaseTag, options.releaseSha)
  }));

  return {
    images,
    upgradePairs: upgradePairsForTracks(selected, allTracks)
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = new Map();

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    }

    args.set(name.slice(2), value);
  }

  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const tracksFile = args.get('tracks-file') ?? 'release-tracks.json';
  const previousFile = args.get('previous-tracks-file');
  const releaseTag = args.get('release-tag');
  const releaseSha = args.get('release-sha');

  if (!releaseTag || !releaseSha) {
    throw new Error('--release-tag and --release-sha are required');
  }

  return buildPublishPlan({
    current: readJson(tracksFile),
    previous: previousFile ? readJson(previousFile) : undefined,
    tracks: args.get('tracks') ?? 'all',
    releaseTag,
    releaseSha
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`${basename(process.argv[1])}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
