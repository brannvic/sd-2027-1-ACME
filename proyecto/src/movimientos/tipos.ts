export enum EstadoPaquete {
  CREADO = 'creado',
  EN_ALMACEN = 'en_almacen',
  EN_CENTRO = 'en_centro_distribucion',
  EN_RUTA = 'en_ruta',
  INTENTO_FALLIDO = 'intento_fallido',
  ENTREGADO = 'entregado',
  EN_SUCURSAL = 'en_sucursal',
}

export enum TipoMovimiento {
  ENVIO_CREADO = 'envio_creado',
  INGRESO_ALMACEN = 'ingreso_almacen',
  INGRESO_CENTRO = 'ingreso_centro_distribucion',
  SALIDA_RUTA = 'salida_ruta',
  INTENTO_FALLIDO = 'intento_fallido',
  ENTREGADO = 'entregado',
  DIRECCION_CORREGIDA = 'direccion_corregida',
  PASO_SUCURSAL = 'paso_sucursal',
}
