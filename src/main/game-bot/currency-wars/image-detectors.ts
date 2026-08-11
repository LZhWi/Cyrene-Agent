import sharp from "sharp";
import type { RatioRegion } from "../window-target";

const AUTO_BATTLE_DISABLED = "iVBORw0KGgoAAAANSUhEUgAAABAAAAARCAYAAADUryzEAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAHYYAAB2GAV2iE4EAAAHISURBVDhPrZPPK0RRFMe/77358YwxjR8z2VCG/NgoUshiZmNB/gAbNpKslCIsZKGE/GhSSokUKwvDkpCFHxs2olAjyc8SQma8mefe++68ebNi5FOve97p3O8553aOYLdZ1WhUhRGTSURejgvZbidEUcDt/TOC14/4Ckd4hIbZLEGwpVhUGO67MtOwH+hHqs3KPRrPrx+oax5D8OqRezQSBGTZjMvdMWZHosD7R4hYKhGTIYnMjYqGAVzfPGk/BNGY3T/QxC2gtLYXhd4u8nWjiJy0AspwbyM7Ywg2mVRAsFgkBHcnWKZB/yqm5jdYQIzKsnx4ct1Y2zjE2zutTEMXSLPLON8ZYaV7ajoRCiks4Cd4Z4AUa5KgKETll+i3BEHgVnLE0/6R/xOIRON9J9ONLhAOa69O39JbVcJsI1kZdhR6stloG9EFPj+/cHZxx+yFyVZYrSZmU+hurMx0YGe5D7Ojrdyroc8BJd2ZitPNIWbTxZle2kZEUdDS6IOD7gZJV988jsPjSxZDSRAAqc5XXYJFf7s++0baeuYQWD+i66GTKMBxuxzwVhajuryA9Czh4OgCW3snuHt44RFxBIddVpOZPCOybMY3M/qDuSeZZeAAAAAASUVORK5CYII=";
const COLLECTION_MARKER = "iVBORw0KGgoAAAANSUhEUgAAABcAAAAWCAYAAAArdgcFAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsIAAA7CARUoSoAAAAGHaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8P3hwYWNrZXQgYmVnaW49J++7vycgaWQ9J1c1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCc/Pg0KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyI+PHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj48cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0idXVpZDpmYWY1YmRkNS1iYTNkLTExZGEtYWQzMS1kMzNkNzUxODJmMWIiIHhtbG5zOnRpZmY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vdGlmZi8xLjAvIj48dGlmZjpPcmllbnRhdGlvbj4xPC90aWZmOk9yaWVudGF0aW9uPjwvcmRmOkRlc2NyaXB0aW9uPjwvcmRmOlJERj48L3g6eG1wbWV0YT4NCjw/eHBhY2tldCBlbmQ9J3cnPz4slJgLAAAB9klEQVRIS+2Uz0uTcRzHX8+znz3bcnu2aptt5EOBiQgpWZQHQRYdgk5lEt7qEkJERv0BQnTpENTZ6h5EaNCppLoJdUrmQTexGUXbfLa5H097PMyF+zoUph6C3vC9fD+vz4svXz58JFVVTfYpsnixl5FUVTV7OwNcjWliDYClH3mmPyVZWNb/3nW0e1hY1hnqDzN0uh1Zlhp6Hk1+Ja2XavLhmMazBwMNQD2FosFiSufF1DyvPyS4PdJNt+bj8t133BvtYXy0B6ul8QNOXX9FciW387coTitdHT4Ge0NoYQ+XBqJEgi4Ra5od5bvJf3nTtCSXJYmgXyEUUJClxjHcnJbkXreDp/fPM3Lx+JYZ35yW5B6XjcG+EHbr9u3bV3eZf1yeW6vtj2ZHz1fEHkwTfq+WtrD1YxhVqG9F30EH0SNu0QFAm9vOtQsasiwx+SbOw7F+Pn5Z4e3nJfJrhogD8G0xTblSrck9LhsnIm0oTqvIEU9kyeRKOO0WTBOQoFj6Q/iQQqTJgzJ6mblEBsPYkPedDPBk/Bydx7wiy/efBW5OzDA794uKUcVhsxA7c5THd87i9zpEnPezKW5MzJBe3djn0aCb4ZhG0K+ILACJVI7nU3GyuTKHfQe4daULj2ITMQDiySwvp+cpFI2aXAT2Kvs2ijarzDq/LLGwSrHP4QAAAABJRU5ErkJggg==";

interface GrayImage { data: Buffer; width: number; height: number }

async function gray(base64: string, width?: number, height?: number): Promise<GrayImage> {
  let pipeline = sharp(Buffer.from(base64, "base64"));
  if (width && height) pipeline = pipeline.resize(width, height, { fit: "fill" });
  const result = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: result.data, width: result.info.width, height: result.info.height };
}

function ncc(source: GrayImage, template: GrayImage, left: number, top: number, sampleStep: number): number {
  let ss = 0; let ts = 0; let ss2 = 0; let ts2 = 0; let product = 0; let count = 0;
  for (let y = 0; y < template.height; y += sampleStep) {
    for (let x = 0; x < template.width; x += sampleStep) {
      const sv = source.data[(top + y) * source.width + left + x];
      const tv = template.data[y * template.width + x];
      ss += sv; ts += tv; ss2 += sv * sv; ts2 += tv * tv; product += sv * tv; count++;
    }
  }
  const sourceVariance = ss2 - ss * ss / count;
  const templateVariance = ts2 - ts * ts / count;
  if (sourceVariance <= 0.001 || templateVariance <= 0.001) return -1;
  return (product - ss * ts / count) / Math.sqrt(sourceVariance * templateVariance);
}

function best(source: GrayImage, template: GrayImage, region: RatioRegion, scanStep: number, sampleStep: number): number {
  const left = Math.floor(source.width * region.x);
  const top = Math.floor(source.height * region.y);
  const right = Math.ceil(source.width * (region.x + region.width)) - template.width;
  const bottom = Math.ceil(source.height * (region.y + region.height)) - template.height;
  let score = -1;
  for (let y = top; y <= bottom; y += scanStep) {
    for (let x = left; x <= right; x += scanStep) score = Math.max(score, ncc(source, template, x, y, sampleStep));
  }
  return score;
}

export async function detectAutoBattleDisabled(base64: string): Promise<{ disabled: boolean; score: number }> {
  const [source, template] = await Promise.all([gray(base64, 144, 120), gray(AUTO_BATTLE_DISABLED)]);
  const score = best(source, template, { x: 0, y: 0, width: 1, height: 1 }, 1, 1);
  return { disabled: score >= 0.9, score };
}

export async function collectionMarkerScores(base64: string, regions: RatioRegion[]): Promise<number[]> {
  const [source, template] = await Promise.all([gray(base64, 1920, 1080), gray(COLLECTION_MARKER)]);
  return regions.map((region) => best(source, template, region, 2, 2));
}
