import {z} from 'zod';
export const serialFormatSchema = {
  dataBits:z.union([z.literal(5),z.literal(6),z.literal(7),z.literal(8)]).optional(),
  parity:z.enum(['none','even','odd']).optional(),
  stopBits:z.union([z.literal(1),z.literal(2)]).optional(),
};
