/**
 * Mascot sprite assets — animated MAGE (pixel wizard), 50 levels / 5 forms.
 *
 * Forms metamorphose every 10 levels: Aprendiz (1-10) → Feiticeiro (11-20) →
 * Arquimago (21-30) → Cavaleiro Arcano (31-40) → Deus Arcano (41-50). Within a
 * form the WORK idle increments per level (aura/weapon/magic).
 *
 * States (see Mascot.tsx):
 *  - WORK  (an agent runs): plays the level's "channeling" idle.
 *  - REST  (idle): cycles cozy idles (breathe, coffee, cat, dragon egg, nap).
 *  - EVOLVE: on crossing a form boundary, plays the one-shot transformation.
 *
 * Each sheet is a horizontal strip of FRAME_COUNT frames of FRAME_W x FRAME_H.
 */
import idle1 from "../../assets/mascot/mage/idle-nv1.png";
import idle2 from "../../assets/mascot/mage/idle-nv2.png";
import idle3 from "../../assets/mascot/mage/idle-nv3.png";
import idle4 from "../../assets/mascot/mage/idle-nv4.png";
import idle5 from "../../assets/mascot/mage/idle-nv5.png";
import idle6 from "../../assets/mascot/mage/idle-nv6.png";
import idle7 from "../../assets/mascot/mage/idle-nv7.png";
import idle8 from "../../assets/mascot/mage/idle-nv8.png";
import idle9 from "../../assets/mascot/mage/idle-nv9.png";
import idle10 from "../../assets/mascot/mage/idle-nv10.png";
import idle11 from "../../assets/mascot/mage/idle-nv11.png";
import idle12 from "../../assets/mascot/mage/idle-nv12.png";
import idle13 from "../../assets/mascot/mage/idle-nv13.png";
import idle14 from "../../assets/mascot/mage/idle-nv14.png";
import idle15 from "../../assets/mascot/mage/idle-nv15.png";
import idle16 from "../../assets/mascot/mage/idle-nv16.png";
import idle17 from "../../assets/mascot/mage/idle-nv17.png";
import idle18 from "../../assets/mascot/mage/idle-nv18.png";
import idle19 from "../../assets/mascot/mage/idle-nv19.png";
import idle20 from "../../assets/mascot/mage/idle-nv20.png";
import idle21 from "../../assets/mascot/mage/idle-nv21.png";
import idle22 from "../../assets/mascot/mage/idle-nv22.png";
import idle23 from "../../assets/mascot/mage/idle-nv23.png";
import idle24 from "../../assets/mascot/mage/idle-nv24.png";
import idle25 from "../../assets/mascot/mage/idle-nv25.png";
import idle26 from "../../assets/mascot/mage/idle-nv26.png";
import idle27 from "../../assets/mascot/mage/idle-nv27.png";
import idle28 from "../../assets/mascot/mage/idle-nv28.png";
import idle29 from "../../assets/mascot/mage/idle-nv29.png";
import idle30 from "../../assets/mascot/mage/idle-nv30.png";
import idle31 from "../../assets/mascot/mage/idle-nv31.png";
import idle32 from "../../assets/mascot/mage/idle-nv32.png";
import idle33 from "../../assets/mascot/mage/idle-nv33.png";
import idle34 from "../../assets/mascot/mage/idle-nv34.png";
import idle35 from "../../assets/mascot/mage/idle-nv35.png";
import idle36 from "../../assets/mascot/mage/idle-nv36.png";
import idle37 from "../../assets/mascot/mage/idle-nv37.png";
import idle38 from "../../assets/mascot/mage/idle-nv38.png";
import idle39 from "../../assets/mascot/mage/idle-nv39.png";
import idle40 from "../../assets/mascot/mage/idle-nv40.png";
import idle41 from "../../assets/mascot/mage/idle-nv41.png";
import idle42 from "../../assets/mascot/mage/idle-nv42.png";
import idle43 from "../../assets/mascot/mage/idle-nv43.png";
import idle44 from "../../assets/mascot/mage/idle-nv44.png";
import idle45 from "../../assets/mascot/mage/idle-nv45.png";
import idle46 from "../../assets/mascot/mage/idle-nv46.png";
import idle47 from "../../assets/mascot/mage/idle-nv47.png";
import idle48 from "../../assets/mascot/mage/idle-nv48.png";
import idle49 from "../../assets/mascot/mage/idle-nv49.png";
import idle50 from "../../assets/mascot/mage/idle-nv50.png";
import evolve1 from "../../assets/mascot/mage/evolve-1.png";
import evolve2 from "../../assets/mascot/mage/evolve-2.png";
import evolve3 from "../../assets/mascot/mage/evolve-3.png";
import evolve4 from "../../assets/mascot/mage/evolve-4.png";
import restBreathe from "../../assets/mascot/mage/rest-breathe.png";
import restCoffee from "../../assets/mascot/mage/rest-coffee.png";
import restCat from "../../assets/mascot/mage/rest-cat.png";
import restEgg from "../../assets/mascot/mage/rest-egg.png";
import restNap from "../../assets/mascot/mage/rest-nap.png";

/** One animation frame is 92x92; sheets carry 17 frames (1 reference + 16). */
export const FRAME_W = 92;
export const FRAME_H = 92;
export const FRAME_COUNT = 17;

/** WORK idles per level (index = level-1), levels 1..50. */
const WORK_SHEETS: readonly string[] = [
  idle1, idle2, idle3, idle4, idle5, idle6, idle7, idle8, idle9, idle10,
  idle11, idle12, idle13, idle14, idle15, idle16, idle17, idle18, idle19, idle20,
  idle21, idle22, idle23, idle24, idle25, idle26, idle27, idle28, idle29, idle30,
  idle31, idle32, idle33, idle34, idle35, idle36, idle37, idle38, idle39, idle40,
  idle41, idle42, idle43, idle44, idle45, idle46, idle47, idle48, idle49, idle50,
];

/** Transformation sheets, indexed by target form (evolve into form 2..5). */
const EVOLVE_SHEETS: readonly string[] = [evolve1, evolve2, evolve3, evolve4];

/** REST idles cycled while the group is idle. */
export const REST_SHEETS: readonly string[] = [
  restBreathe, restCoffee, restCat, restEgg, restNap,
];

/** Form index (0..4) for a level: Aprendiz=0, Feiticeiro=1, … Deus=4. */
export function formIndex(level: number): number {
  return Math.min(4, Math.max(0, Math.floor((Math.floor(level) - 1) / 10)));
}

/** The "channeling" sheet for a level, clamped to 1..50. */
export function workSheet(level: number): string {
  const idx = Math.min(Math.max(Math.floor(level) || 1, 1), WORK_SHEETS.length) - 1;
  return WORK_SHEETS[idx];
}

/** The transformation sheet to play when evolving INTO the given form index
 * (1..4 → forms 2..5). Returns null for form 0 (no evolution into Aprendiz). */
export function evolveSheet(targetFormIndex: number): string | null {
  if (targetFormIndex < 1 || targetFormIndex > EVOLVE_SHEETS.length) return null;
  return EVOLVE_SHEETS[targetFormIndex - 1];
}
