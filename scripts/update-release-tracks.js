#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = 'release-tracks.json';
const POSTGRES_REPOSITORY = 'library/postgres';
const REGISTRY_AUTH_URL = 'https://auth.docker.io/token';
const REGISTRY_URL = 'https://registry-1.docker.io';

export function parseBookwormTag(tag) {
  const match = /^(\d+)\.(\d+)-bookworm$/.exec(tag);

  if (!match) {
    return undefined;
  }

  return {
    tag,
    major: match[1],
    minor: Number(match[2])
  };
}

export function latestBookwormTagsByMajor(tags) {
  const latest = new Map();

  for (const tag of tags) {
    const parsed = parseBookwormTag(tag);

    if (!parsed) {
      continue;
    }

    const existing = latest.get(parsed.major);
    if (!existing || parsed.minor > existing.minor) {
      latest.set(parsed.major, parsed);
    }
  }

  return [...latest.values()].toSorted((a, b) => Number(a.major) - Number(b.major));
}

export function addMissingMajorTracks(releaseTracks, candidates) {
  const existingMajors = new Set(releaseTracks.tracks.map((track) => track.major));
  const highestExistingMajor = Math.max(...releaseTracks.tracks.map((track) => Number(track.major)));
  const additions = candidates.filter((candidate) =>
    Number(candidate.major) > highestExistingMajor && !existingMajors.has(candidate.major)
  );

  if (additions.length === 0) {
    return {
      changed: false,
      releaseTracks,
      additions: []
    };
  }

  return {
    changed: true,
    additions,
    releaseTracks: {
      ...releaseTracks,
      tracks: [
        ...releaseTracks.tracks,
        ...additions.map((candidate) => ({
          major: candidate.major,
          minor: `${candidate.major}.${candidate.minor}`,
          base: `postgres:${candidate.tag}@${candidate.digest}`
        }))
      ].toSorted((a, b) => Number(a.major) - Number(b.major))
    }
  };
}

async function dockerHubToken() {
  const url = new URL(REGISTRY_AUTH_URL);
  url.searchParams.set('service', 'registry.docker.io');
  url.searchParams.set('scope', `repository:${POSTGRES_REPOSITORY}:pull`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Docker registry auth failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  return body.token;
}

async function fetchPostgresTags(token) {
  const tags = [];
  let url = `${REGISTRY_URL}/v2/${POSTGRES_REPOSITORY}/tags/list?n=1000`;

  while (url) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`Docker tag list failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    tags.push(...(body.tags ?? []));
    url = nextPageUrl(response.headers.get('link'));
  }

  return tags;
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) {
    return undefined;
  }

  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  if (!match) {
    return undefined;
  }

  return match[1].startsWith('http') ? match[1] : `${REGISTRY_URL}${match[1]}`;
}

async function fetchDigest(token, tag) {
  const response = await fetch(`${REGISTRY_URL}/v2/${POSTGRES_REPOSITORY}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
      ].join(', ')
    }
  });

  if (!response.ok) {
    throw new Error(`Docker digest lookup failed for ${tag}: ${response.status} ${response.statusText}`);
  }

  const digest = response.headers.get('docker-content-digest');
  if (!digest) {
    throw new Error(`Docker digest lookup for ${tag} did not return docker-content-digest`);
  }

  return digest;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/update-release-tracks.js [release-tracks.json]\n');
    return;
  }

  const file = process.argv[2] || DEFAULT_FILE;
  const releaseTracks = JSON.parse(readFileSync(file, 'utf8'));
  const token = await dockerHubToken();
  const tags = await fetchPostgresTags(token);
  const candidates = latestBookwormTagsByMajor(tags);
  const highestExistingMajor = Math.max(...releaseTracks.tracks.map((track) => Number(track.major)));
  const missingMajors = candidates.filter((candidate) => Number(candidate.major) > highestExistingMajor);

  for (const candidate of missingMajors) {
    candidate.digest = await fetchDigest(token, candidate.tag);
  }

  const result = addMissingMajorTracks(releaseTracks, missingMajors);

  if (!result.changed) {
    console.error('No new PostgreSQL major release tracks found.');
    return;
  }

  writeFileSync(file, `${JSON.stringify(result.releaseTracks, null, 2)}\n`);
  console.error(`Added PostgreSQL major release track(s): ${result.additions.map((track) => track.major).join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
