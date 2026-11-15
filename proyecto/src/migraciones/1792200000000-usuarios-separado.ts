import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 02-usuarios: las cuentas y sesiones ahora viven en el servicio Usuarios, con sus propias bases.
 * - Se quitan las llaves foráneas hacia usuarios: entre servicios no hay FK, solo identificadores.
 * - Se borran usuarios y sesiones de esta base: cada dato tiene un solo dueño.
 * - Llega la lista local de sesiones revocadas (alimentada por eventos sesion_terminada).
 * - Un movimiento sensible puede quedar "pendiente" de confirmación si no se pudo verificar la sesión.
 */
export class UsuariosSeparado1792200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ DECLARE fk record; BEGIN
        FOR fk IN SELECT conrelid::regclass AS tabla, conname FROM pg_constraint WHERE confrelid = 'usuarios'::regclass LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tabla, fk.conname);
        END LOOP;
      END $$;
      DROP TABLE sesiones;
      DROP TABLE usuarios;

      CREATE TABLE sesiones_revocadas (
        "sesionId" uuid PRIMARY KEY, "usuarioId" uuid NOT NULL,
        "venceEn" timestamptz NOT NULL, "recibidaEn" timestamptz NOT NULL
      );

      ALTER TABLE historial_movimientos
        ADD COLUMN "sesionId" uuid,
        ADD COLUMN confirmacion varchar NOT NULL DEFAULT 'confirmada' CHECK (confirmacion IN ('confirmada','pendiente','rechazada')),
        ADD COLUMN "notaConfirmacion" text;
      CREATE INDEX movimientos_pendientes ON historial_movimientos (secuencia) WHERE confirmacion = 'pendiente';

      ALTER TABLE paquetes DROP CONSTRAINT paquetes_estado_check, ADD CONSTRAINT paquetes_estado_check
        CHECK (estado IN ('creado','en_almacen','en_centro_distribucion','en_ruta','intento_fallido','entrega_por_confirmar','entregado','en_sucursal'));
    `);
  }

  async down(): Promise<void> {
    throw new Error('Migración irreversible: las cuentas ya viven en el servicio Usuarios');
  }
}
