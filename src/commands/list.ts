// src/commands/list.ts
import type { CommandDefinition } from './registry';
import { pingCommand } from './ping';
import { helpCommand } from './help';
import { statusCommand } from './status';
import { animeCommand } from './anime';
import { aiCommand } from './ai';
import { clearcacheCommand } from './clearcache';
import {
  decodeCommand,
  listCommand,
  deleteCommand,
  batchCommand,
} from './decode';
import {
  databaseAnimeCommand,
  dbaShortCommand,
  endCommand,
} from './database-anime';
import { vaCommand } from './va';
import {
  publishAnimeCommand,
  publishBatchCommand,
  batchResetCommand,
  publishCommand,
} from './publish';
import { postCommand } from './post';
import { killCommand } from './kill';
import { trackCommand } from './track';
import { editCommand } from './edit';

export const COMMANDS: CommandDefinition[] = [
  pingCommand,
  helpCommand,
  statusCommand,
  animeCommand,
  databaseAnimeCommand,
  dbaShortCommand,
  endCommand,
  vaCommand,
  aiCommand,
  clearcacheCommand,
  decodeCommand,
  batchCommand,
  listCommand,
  deleteCommand,
  publishAnimeCommand,
  publishBatchCommand,
  batchResetCommand,
  publishCommand,
  postCommand,
  editCommand,
  trackCommand,
  killCommand,
];
