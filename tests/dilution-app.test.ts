import { afterEach, describe, expect, it } from 'vitest';
import { startDilutionApp } from '../examples/dilution-app/server.ts';

const apps: Awaited<ReturnType<typeof startDilutionApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function start() {
  const app = await startDilutionApp({ port: 0, defects: [] });
  apps.push(app);
  return app;
}

const preparation = {
  sampleId: 'ASSAY-001',
  stockConcentration: '2',
  stockUnit: 'mg/mL',
  targetConcentration: '300',
  targetUnit: 'ug/mL',
  finalVolume: '1500',
  volumeUnit: 'uL',
};

async function save(url: string, values: Record<string, unknown>) {
  return fetch(`${url}/api/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
}

async function records(url: string) {
  return (await fetch(`${url}/api/plans`)).json();
}

describe('corrected dilution sandbox', () => {
  it('normalizes concentration and volume independently and accepts neat stock', async () => {
    const app = await start();
    const result = await save(app.url, preparation);
    expect(result.status).toBe(201);
    // 300 ug/mL = 0.3 mg/mL; 1500 uL = 1.5 mL.
    // C1*V1 = C2*V2 gives 0.225 mL stock and 1.275 mL diluent.
    const { plan } = await result.json();
    expect(plan).toMatchObject({
      sampleId: 'ASSAY-001',
      stockMgMl: 2,
      targetMgMl: 0.3,
      finalMl: 1.5,
    });
    expect(plan.stockMl).toBeCloseTo(0.225, 12);
    expect(plan.diluentMl).toBeCloseTo(1.275, 12);

    const neat = await save(app.url, {
      ...preparation,
      sampleId: 'NEAT',
      targetConcentration: '2000',
    });
    expect(neat.status).toBe(201);
    expect((await neat.json()).plan).toMatchObject({ stockMl: 1.5, diluentMl: 0 });
  });

  it('rejects malformed, impossible, and out-of-range inputs without changing records', async () => {
    const app = await start();
    expect((await save(app.url, preparation)).status).toBe(201);
    const original = await records(app.url);
    const rejected: Record<string, unknown>[] = [
      { finalVolume: '0' },
      { finalVolume: '-1' },
      { finalVolume: 'Infinity' },
      { stockConcentration: 'NaN' },
      { targetConcentration: '1e999' },
      { stockConcentration: ' ' },
      { targetConcentration: '0' },
      { targetConcentration: '-1' },
      { targetConcentration: '2001' },
      { stockConcentration: '1000000001' },
      { finalVolume: '1000000001', volumeUnit: 'mL' },
      { stockUnit: 'g/L' },
      { volumeUnit: 'L' },
      { sampleId: ' ' },
      { sampleId: 'A'.repeat(33) },
      { sampleId: '<script>' },
    ];
    for (const [index, changes] of rejected.entries()) {
      const response = await save(app.url, {
        ...preparation,
        sampleId: `REJECT-${index}`,
        ...changes,
      });
      expect(response.status, JSON.stringify(changes)).toBe(422);
      expect((await response.json()).error).toEqual(expect.any(String));
      expect(await records(app.url)).toEqual(original);
    }
  });

  it('rejects a trimmed duplicate without replacing the original preparation', async () => {
    const app = await start();
    expect((await save(app.url, preparation)).status).toBe(201);
    const original = await records(app.url);
    const duplicate = await save(app.url, {
      ...preparation,
      sampleId: ' ASSAY-001 ',
      finalVolume: '1000',
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe(
      'Sample ID already exists. The original record is unchanged.',
    );
    expect(await records(app.url)).toEqual(original);

    expect((await save(app.url, { ...preparation, sampleId: 'assay-001' })).status).toBe(201);
    expect((await records(app.url)).plans).toHaveLength(2);
  });

  it('preserves representable results when an intermediate calculation would underflow', async () => {
    const app = await start();
    const neat = await save(app.url, {
      ...preparation,
      sampleId: 'SMALL-NEAT',
      stockConcentration: '5e-324',
      targetConcentration: '5e-324',
      targetUnit: 'mg/mL',
      finalVolume: '0.1',
      volumeUnit: 'mL',
    });
    expect(neat.status).toBe(201);
    expect((await neat.json()).plan).toMatchObject({ stockMl: 0.1, diluentMl: 0 });

    const diluted = await save(app.url, {
      ...preparation,
      sampleId: 'SMALL-DILUTION',
      stockConcentration: '1000000000',
      targetConcentration: '5e-324',
      targetUnit: 'mg/mL',
      finalVolume: '1000000000',
      volumeUnit: 'mL',
    });
    expect(diluted.status).toBe(201);
    expect((await diluted.json()).plan.stockMl).toBe(Number.MIN_VALUE);
  });
});
