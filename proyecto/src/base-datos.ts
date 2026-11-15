import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Paquete, Movimiento } from './movimientos/paquete.entity';
import { IntentoEntrega, ProgramacionReintento } from './reintentos/reintento.entity';
import { EsquemaInicial1792100000000 } from './migraciones/1792100000000-esquema-inicial';
import { UsuariosSeparado1792200000000 } from './migraciones/1792200000000-usuarios-separado';

export const opcionesBaseDatos: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'acme',
  password: process.env.DB_PASSWORD ?? 'acme_desarrollo',
  database: process.env.DB_NAME ?? 'acme',
  connectTimeoutMS: 3000,
  entities: [Paquete, Movimiento, IntentoEntrega, ProgramacionReintento],
  migrations: [EsquemaInicial1792100000000, UsuariosSeparado1792200000000],
  synchronize: false,
};

export default new DataSource(opcionesBaseDatos);
