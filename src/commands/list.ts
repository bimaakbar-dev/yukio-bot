// src/commands/list.ts
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
  endCommand,
} from './database-anime';
import { vaCommand } from './va';

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
  listCommand,
  deleteCommand,
];