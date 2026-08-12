const { z } = require('zod');

const upsertMine = z.object({
  categories: z.array(z.string().min(1)).optional(),
  regions: z.array(z.string().min(1)).optional(),
  location: z.object({
    lat: z.number().nullable(),
    lng: z.number().nullable(),
  }).optional(),
  bio: z.string().max(2000).optional(),
  yearsExperience: z.number().min(0).max(80).optional(),
  isAvailable: z.boolean().optional(),
});

const setAvailability = z.object({
  dates: z.array(
    z.object({
      date: z.coerce.date(),
      isAvailable: z.boolean(),
    })
  ).min(1),
});

module.exports = { upsertMine, setAvailability };
