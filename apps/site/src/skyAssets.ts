// The sky's maps and star data, imported so the build names each file after a hash of its contents
// (e.g. earth_day_4096-Ab12Cd34.jpg). The server caches hashed files for a year, so after the first
// visit they come from the device, even across deploys, until a picture itself changes.
import brc2048 from './sky/earth_bump_roughness_clouds_2048.jpg?url';
import brc4096 from './sky/earth_bump_roughness_clouds_4096.jpg?url';
import day2048 from './sky/earth_day_2048.jpg?url';
import day4096 from './sky/earth_day_4096.jpg?url';
import night2048 from './sky/earth_night_2048.jpg?url';
import night4096 from './sky/earth_night_4096.jpg?url';
import mw2048 from './sky/milkyway_2048.jpg?url';
import mw4096 from './sky/milkyway_4096.jpg?url';
import starsBin from './sky/stars.bin?url';

export type Res = 2048 | 4096;

export const SKY_ASSETS = {
  earth_day: { 2048: day2048, 4096: day4096 },
  earth_night: { 2048: night2048, 4096: night4096 },
  earth_bump_roughness_clouds: { 2048: brc2048, 4096: brc4096 },
  milkyway: { 2048: mw2048, 4096: mw4096 },
  stars: starsBin,
} as const;
