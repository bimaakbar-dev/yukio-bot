import type { CommandDefinition } from './registry';
import { pingCommand } from './ping';
import { helpCommand } from './help';
import { statusCommand } from './status';
import { animeCommand } from './anime';
import { aiCommand } from './ai';
import { clearcacheCommand } from './clearcache';
import { decodeCommand, listCommand, deleteCommand } from './decode';
import {
  databaseAnimeCommand,
  dbaShortCommand,
} from './database-anime';

export const COMMANDS: CommandDefinition[] = [
  pingCommand,
  helpCommand,
  statusCommand,
  animeCommand,
  databaseAnimeCommand,
  dbaShortCommand,
  aiCommand,
  clearcacheCommand,
  decodeCommand,
  listCommand,
  deleteCommand,
];
