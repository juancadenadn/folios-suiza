/* Capa de nube del sistema de folios.
   Traduce entre la forma que usa la app (folio con piezas adentro) y las
   tablas de la base de datos. No contiene reglas de permisos: esas viven
   en el servidor (ver esquema.sql). */
(function () {
  var LS_CFG = "folios_nube_cfg";
  var DOMINIO = "@folios.app";        // el usuario "angie" entra como angie@folios.app
  /* El servicio de login pide 6 caracteres como mínimo. Para permitir
     contraseñas cortas se le agrega este sufijo fijo, que nadie escribe
     ni ve. Debe ser idéntico al de empleadas.sql. */
  var SUFIJO = "-jr26";
  var INACTIVIDAD = 15 * 60 * 1000;   // la sesión se cierra sola tras 15 min sin tocar nada

  var cfg = null, sb = null, canal = null, oyentes = [], reloj = null;
  var relojInact = null, alExpirar = null;
  /* Diferencia entre el reloj del servidor y el de este aparato, en milisegundos.
     Si la computadora tiene la hora mal puesta, aquí queda el ajuste. */
  var desfase = 0, relojSincronizado = false;
  try { cfg = JSON.parse(localStorage.getItem(LS_CFG)); } catch (e) { cfg = null; }
  if (window.FOLIOS_CONFIG && window.FOLIOS_CONFIG.url) cfg = window.FOLIOS_CONFIG;

  function omitir(obj, llaves) {
    var out = {};
    for (var k in obj) if (obj.hasOwnProperty(k) && llaves.indexOf(k) < 0) out[k] = obj[k];
    return out;
  }
  function numOnull(v) {
    if (v === "" || v === null || v === undefined || isNaN(Number(v))) return null;
    return Number(v);
  }

  var Nube = {
    configurado: function () { return !!(cfg && cfg.url && cfg.key); },
    config: function () { return cfg || {}; },

    guardarConfig: function (url, key) {
      url = String(url || "").trim().replace(/\/+$/, "");
      key = String(key || "").trim();
      if (!/^https:\/\/.+\..+/.test(url)) throw new Error("La dirección del proyecto no se ve bien. Debe empezar con https://");
      if (key.length < 30) throw new Error("La llave pública se ve incompleta.");
      cfg = { url: url, key: key };
      localStorage.setItem(LS_CFG, JSON.stringify(cfg));
      sb = null;
      return cfg;
    },

    cliente: function () {
      if (!this.configurado()) throw new Error("Falta configurar la conexión.");
      if (!sb) {
        if (!window.supabase) throw new Error("No cargó la librería de la nube. Revisa tu internet y recarga.");
        sb = window.supabase.createClient(cfg.url, cfg.key, {
          auth: { persistSession: true, autoRefreshToken: true }
        });
      }
      return sb;
    },

    nuevoId: function () {
      return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },

    /* ---------------- reloj del servidor ----------------
       El reloj de cada computadora de tienda no es de fiar: basta que alguien
       le mueva la hora para que los folios nazcan con fecha equivocada y los
       "días sin movimiento" salgan mal. Al entrar se le pregunta la hora al
       servidor y se guarda la diferencia; de ahí en adelante todas las fechas
       del sistema salen de ahí. Sin internet se sigue usando la del aparato,
       igual que antes. */
    sincronizarReloj: function () {
      if (!this.configurado()) return Promise.resolve(false);
      var antes = Date.now();
      return this.cliente().rpc("ahora").then(function (r) {
        if (r.error || !r.data) return false;
        var servidor = new Date(r.data).getTime();
        if (!servidor) return false;
        /* Se le resta la mitad del viaje de ida y vuelta para no contar la
           tardanza de la red como si fuera desfase del reloj. */
        var viaje = (Date.now() - antes) / 2;
        desfase = servidor - (antes + viaje);
        relojSincronizado = true;
        return true;
      }).catch(function () { return false; });
    },

    /* Milisegundos ahora mismo, según el servidor. */
    ahoraMs: function () { return Date.now() + desfase; },

    /* La fecha de hoy en Chihuahua (AAAA-MM-DD). Chihuahua no es la misma zona
       que Ciudad de México, y el servidor trabaja en UTC: sin esto, un folio
       capturado a las 7 de la noche se guardaría con la fecha del día
       siguiente. */
    hoy: function () {
      var d = new Date(this.ahoraMs());
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Chihuahua", year: "numeric", month: "2-digit", day: "2-digit"
        }).format(d);
      } catch (e) {
        return d.toISOString().slice(0, 10);
      }
    },

    /* Para avisar en pantalla cuando el reloj del aparato está muy mal.
       Devuelve los minutos de diferencia, o null si no se pudo consultar. */
    desfaseMinutos: function () {
      if (!relojSincronizado) return null;
      return Math.round(desfase / 60000);
    },

    /* ---------------- sesión ---------------- */
    /* Trae el perfil de quien está dentro: nombre real, rol y tienda.
       El nombre sale de aquí, no de lo que alguien escriba en pantalla. */
    miPerfil: function () {
      return this.cliente().from("perfiles")
        .select("usuario,nombre,rol,tienda,activa").limit(1)
        .then(function (r) {
          if (r.error) throw r.error;
          var p = (r.data || [])[0];
          if (!p) throw new Error("Tu cuenta no tiene perfil asignado. Avisa al líder.");
          if (!p.activa) throw new Error("Esta cuenta está dada de baja.");
          return p;
        });
    },

    entrar: function (usuario, password) {
      var self = this;
      var u = String(usuario || "").trim().toLowerCase();
      if (!u) return Promise.reject(new Error("Escribe tu usuario."));
      if (!password) return Promise.reject(new Error("Escribe tu contraseña."));
      return this.cliente().auth
        .signInWithPassword({ email: u + DOMINIO, password: password + SUFIJO })
        .then(function (r) {
          if (r.error) throw r.error;
          return self.miPerfil();
        })
        .then(function (p) {
          self.tocar();
          return self.sincronizarReloj().then(function () { return p; });
        });
    },

    salir: function () {
      clearTimeout(relojInact);
      if (canal) { try { this.cliente().removeChannel(canal); } catch (e) {} canal = null; }
      oyentes = [];
      if (!this.configurado()) return Promise.resolve();
      return this.cliente().auth.signOut().catch(function () {});
    },

    /* Si la sesión guardada sigue viva, devuelve el perfil. */
    sesionActual: function () {
      if (!this.configurado()) return Promise.resolve(null);
      var self = this;
      return this.cliente().auth.getSession().then(function (r) {
        var s = r.data && r.data.session;
        if (!s || !s.user) return null;
        return self.miPerfil().then(function (p) {
          self.tocar();
          return self.sincronizarReloj().then(function () { return p; });
        }).catch(function () { return null; });
      });
    },

    /* ---------------- cierre por inactividad ----------------
       Varias personas comparten la computadora del mostrador. Si nadie
       toca nada en 15 minutos, la sesión se cierra para que el siguiente
       movimiento no quede firmado con el nombre de quien entró en la
       mañana. */
    alExpirar: function (fn) { alExpirar = fn; },

    /* Minutos sin tocar nada antes de cerrar la sesión. Lo decide el líder en
       Configuración y aplica a todas las computadoras. */
    inactividadMin: function () { return Math.round(INACTIVIDAD / 60000); },
    fijarInactividadLocal: function (min) {
      var m = parseInt(min, 10);
      if ([5, 10, 15, 20, 30].indexOf(m) < 0) return;
      INACTIVIDAD = m * 60000;
      if (alExpirar) this.tocar();
    },
    cargarAjustes: function () {
      var self = this;
      return this.cliente().from("ajustes").select("clave,valor").then(function (r) {
        if (r.error) return self.inactividadMin();   // sin la tabla, se queda en 15
        (r.data || []).forEach(function (a) { if (a.clave === "inactividad_min") self.fijarInactividadLocal(a.valor); });
        return self.inactividadMin();
      }).catch(function () { return self.inactividadMin(); });
    },
    guardarInactividad: function (min) {
      var self = this;
      return this.cliente().from("ajustes")
        .upsert({ clave: "inactividad_min", valor: String(min) })
        .then(function (r) {
          if (r.error) throw new Error(/ajustes/.test(r.error.message || "") ? "Falta correr ajustes.sql en Supabase." : r.error.message);
          self.fijarInactividadLocal(min);
          return self.inactividadMin();
        });
    },

    tocar: function () {
      clearTimeout(relojInact);
      if (!alExpirar) return;
      relojInact = setTimeout(function () {
        var fn = alExpirar;
        Nube.salir().then(function () { if (fn) fn(); });
      }, INACTIVIDAD);
    },

    /* ---------------- empleadas (solo el líder) ---------------- */
    empleadas: function () {
      return this.cliente().from("perfiles")
        .select("usuario,nombre,rol,tienda,activa,baja_en")
        .order("activa", { ascending: false }).order("nombre", { ascending: true })
        .then(function (r) { if (r.error) throw r.error; return r.data || []; });
    },

    crearEmpleada: function (usuario, nombre, tienda, password, rol) {
      return this.cliente().rpc("crear_empleada", {
        p_usuario: String(usuario || "").trim().toLowerCase(),
        p_nombre: String(nombre || "").trim(),
        p_tienda: tienda,
        p_password: password,
        p_rol: rol === "lider" ? "lider" : "empleada"
      }).then(function (r) { if (r.error) throw r.error; return r.data; });
    },

    editarEmpleada: function (usuario, datos) {
      return this.cliente().rpc("editar_empleada", {
        p_usuario: usuario,
        p_nombre: String((datos && datos.nombre) || "").trim(),
        p_tienda: (datos && datos.tienda) || null,
        p_rol: (datos && datos.rol) === "lider" ? "lider" : "empleada"
      }).then(function (r) { if (r.error) throw r.error; });
    },

    darBaja: function (usuario) {
      return this.cliente().rpc("dar_baja_empleada", { p_usuario: usuario })
        .then(function (r) { if (r.error) throw r.error; });
    },

    reactivar: function (usuario, password) {
      return this.cliente().rpc("reactivar_empleada", { p_usuario: usuario, p_password: password })
        .then(function (r) { if (r.error) throw r.error; });
    },

    /* ---------------- lectura ---------------- */
    cargarTodo: function () {
      var sbc = this.cliente();
      return Promise.all([
        sbc.from("folios").select("*").order("fecha", { ascending: false }).order("creado_en", { ascending: false }),
        sbc.from("piezas").select("*").order("orden", { ascending: true }),
        sbc.from("piezas_costo").select("*")
      ]).then(function (res) {
        for (var i = 0; i < res.length; i++) if (res[i].error) throw res[i].error;
        var folios = res[0].data || [], piezas = res[1].data || [], costos = res[2].data || [];
        var costoDe = {};
        costos.forEach(function (c) { costoDe[c.pieza_id] = c.costo; });
        var porFolio = {};
        piezas.forEach(function (p) { (porFolio[p.folio_id] = porFolio[p.folio_id] || []).push(p); });

        return folios.map(function (f) {
          var base = Object.assign({}, f.datos || {});
          var mov = f.actualizado_en ? new Date(f.actualizado_en).getTime() : Nube.ahoraMs();
          return Object.assign(base, {
            id: f.id,
            folioFisico: f.folio_fisico,
            fecha: f.fecha,
            tienda: f.tienda,
            fase: f.fase,
            cliente: f.cliente,
            tel: f.tel,
            empleada: f.empleada,
            anticipo: Number(f.anticipo || 0),
            notas: f.notas || "",
            historial: f.historial || [],
            diasParado: Math.max(0, Math.floor((Nube.ahoraMs() - mov) / 86400000)),
            piezas: (porFolio[f.id] || []).map(function (p) {
              var pb = Object.assign({}, p.datos || {});
              return Object.assign(pb, {
                id: p.id,
                tipo: p.tipo,
                taller: p.taller,
                estatus: p.estatus,
                precio: p.precio === null || p.precio === undefined ? null : Number(p.precio),
                costo: costoDe[p.id] === undefined || costoDe[p.id] === null ? null : Number(costoDe[p.id])
              });
            })
          });
        });
      });
    },

    bitacora: function (limite) {
      return this.cliente().from("bitacora").select("*")
        .order("cuando", { ascending: false }).limit(limite || 400)
        .then(function (r) { if (r.error) throw r.error; return r.data || []; });
    },

    /* ---------------- escritura ---------------- */
    guardarFolio: function (f) {
      var sbc = this.cliente();
      var fijos = ["id", "folioFisico", "fecha", "tienda", "fase", "cliente", "tel", "empleada",
                   "anticipo", "notas", "historial", "piezas", "diasParado"];
      var fila = {
        id: f.id,
        folio_fisico: String(f.folioFisico || ""),
        fecha: f.fecha || null,
        tienda: f.tienda,
        fase: f.fase || "proceso",
        cliente: String(f.cliente || ""),
        tel: String(f.tel || ""),
        empleada: String(f.empleada || ""),
        anticipo: Number(f.anticipo || 0),
        notas: String(f.notas || ""),
        historial: f.historial || [],
        datos: omitir(f, fijos)
      };

      var piezas = f.piezas || [];
      var filasP = piezas.map(function (p, i) {
        return {
          id: p.id,
          folio_id: f.id,
          orden: i,
          tipo: p.tipo || "Joyería",
          taller: p.taller || "francisco",
          estatus: p.estatus || "esperando_costo",
          precio: numOnull(p.precio),
          datos: omitir(p, ["id", "tipo", "taller", "estatus", "precio", "costo"])
        };
      });
      var costos = piezas
        .filter(function (p) { return numOnull(p.costo) !== null; })
        .map(function (p) { return { pieza_id: p.id, folio_id: f.id, costo: numOnull(p.costo) }; });

      return sbc.from("folios").upsert(fila).then(function (r) {
        if (r.error) throw r.error;
        if (!filasP.length) return { error: null };
        return sbc.from("piezas").upsert(filasP);
      }).then(function (r) {
        if (r && r.error) throw r.error;
        if (!costos.length) return { error: null };
        return sbc.from("piezas_costo").upsert(costos);
      }).then(function (r) {
        if (r && r.error) throw r.error;
        /* A propósito NO se borran las piezas que no vienen en la lista.
           Quien guarda solo manda las que tiene permitido ver: si se
           borrara por ausencia, Revolución destruiría las piezas de Taller
           Rosa de Senderos cada vez que guarda el folio. */
        return null;
      });
    },

    cambiarPassword: function (usuario, password) {
      return this.cliente().rpc("cambiar_password", { p_usuario: usuario, p_password: password })
        .then(function (r) { if (r.error) throw r.error; });
    },

    /* ---------------- tiempo real ---------------- */
    /* Se puede llamar varias veces: solo el primer llamado abre el canal.
       Ojo: hay que llamarlo DESPUÉS de iniciar sesión — sin sesión el
       servidor rechaza la suscripción. */
    onCambio: function (fn) {
      if (!oyentes.length) oyentes.push(fn);
      if (canal || !this.configurado()) return;
      var avisar = function () {
        clearTimeout(reloj);
        reloj = setTimeout(function () { oyentes.forEach(function (f) { f(); }); }, 700);
      };
      try {
        canal = this.cliente().channel("folios-vivo")
          .on("postgres_changes", { event: "*", schema: "public", table: "folios" }, avisar)
          .on("postgres_changes", { event: "*", schema: "public", table: "piezas" }, avisar)
          .on("postgres_changes", { event: "*", schema: "public", table: "piezas_costo" }, avisar)
          .subscribe();
      } catch (e) { canal = null; }
    }
  };

  window.Nube = Nube;
})();
