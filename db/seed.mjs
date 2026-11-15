// Dados iniciais fictícios: barbearia, quatro barbeiros, serviços e expediente.
// Sem clientes, senhas, logins ou sessões. Idempotente: rodar de novo não duplica nem sobrescreve edições.
import { transaction } from './transacao.mjs';

export const SEED_SHOP_ID = '6f1d2c3a-0b4e-4c5d-8e9f-000000000001';

export const SEED_BARBERS = [
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000b1', name: 'Rafael Monteiro', bio: 'Cortes clássicos e navalhado.' },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000b2', name: 'Diego Alencar', bio: 'Degradê e desenhos.' },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000b3', name: 'Lucas Ferraz', bio: 'Barba terapia e acabamento.' },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000b4', name: 'Bruno Tavares', bio: 'Cortes modernos e texturizados.' },
];

export const SEED_SERVICES = [
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000c1', name: 'Corte masculino', description: 'Corte com lavagem e finalização.', duration: 45, price: 6000 },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000c2', name: 'Barba completa', description: 'Toalha quente, navalha e hidratação.', duration: 30, price: 4500 },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000c3', name: 'Corte + barba', description: 'Combo completo.', duration: 75, price: 9500 },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000c4', name: 'Pezinho e sobrancelha', description: 'Acabamento rápido.', duration: 15, price: 2500 },
  { id: '6f1d2c3a-0b4e-4c5d-8e9f-0000000000c5', name: 'Pigmentação', description: 'Correção de falhas em barba ou cabelo.', duration: 60, price: 8000 },
];

// Segunda (1) a sábado (6), 09:00–19:00 no fuso da barbearia; domingo fechado.
export const SEED_HOURS = { weekdays: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00' };

export async function seed(pool) {
  return transaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO shops (id, name, timezone, address, contact_phone)
       VALUES ($1, 'Barber Prime', 'America/Sao_Paulo', 'Endereço configurável no painel', NULL)
       ON CONFLICT (id) DO NOTHING`,
      [SEED_SHOP_ID],
    );
    for (const [i, b] of SEED_BARBERS.entries()) {
      const { rowCount } = await tx.query(
        `INSERT INTO staff (id, shop_id, name, role, bio, sort_order)
         VALUES ($1, $2, $3, 'barber', $4, $5) ON CONFLICT (id) DO NOTHING`,
        [b.id, SEED_SHOP_ID, b.name, b.bio, i + 1],
      );
      if (rowCount === 0) continue; // barbeiro já existia: não recria expediente editado
      for (const weekday of SEED_HOURS.weekdays) {
        await tx.query(
          'INSERT INTO working_hours (staff_id, weekday, start_local, end_local) VALUES ($1, $2, $3, $4)',
          [b.id, weekday, SEED_HOURS.start, SEED_HOURS.end],
        );
      }
    }
    for (const [i, s] of SEED_SERVICES.entries()) {
      await tx.query(
        `INSERT INTO services (id, shop_id, name, description, duration_minutes, price_cents, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [s.id, SEED_SHOP_ID, s.name, s.description, s.duration, s.price, i + 1],
      );
    }
    return { shopId: SEED_SHOP_ID, barbers: SEED_BARBERS.length, services: SEED_SERVICES.length };
  });
}
