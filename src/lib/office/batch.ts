/**
 * Penggabung (batching) geometri statis.
 *
 * Masalah yang dipecahkan: kantor ini dibangun dari ~1.600 mesh kecil, masing-masing
 * dengan materialnya SENDIRIKAN (`box()` dan `cyl()` memanggil `stdMat()` setiap kali).
 * Artinya satu frame meminta GPU mengerjakan ~1.400 draw callgedung + ~300 lagi untuk
 * jalan di depan — dan setiap draw call juga mengulang biaya set-up. Diukur di browser
 * nyata sebelum modul ini ada: 2.863 draw call per frame.
 *
 * Cara kerjanya:
 *
 *   1. Kumpulkan mesh statis yang aman digabung (lihat `isBatchable`).
 *   2. Kelompokkan per MATERIAL — bukan per material instance, tapi per PROPERTI
 *      (warna, roughness, metalness, emissive, peta). Kunci inilah yang membuat
 *      penggabungan bisa terjadi: `box()` membuat material baru tiap panggilan, jadi
 *      mengelompokkan per instance UUID tidak akan pernah menggabungkan apa pun.
 *   3. Bake `matrixWorld` ke dalam geometri, gabungkan, jadikan SATU mesh per grup.
 *
 * Yang TIDAK boleh disentuh (dinamis / bisa diklik / materialnya diubah runtime):
 * monitor meja, papan kanban, papan tulis, plat nama kantor, layar TV lounge, api
 * dan asap BBQ, rak bar, bohlam kesehatan, panel lampu `streaks`, serta seluruh isi
 * street group yang bergerak (pejalan kaki, kendaraan, pohon tertiup angin). Semua
 * itu ditandai `userData.dynamic` di build.ts atau dikenali dari nama/userData.
 *
 * Mesh transparan / material fisika (kaca, air) sengaja tidak digabung: pengurutan
 * render objek transparan sudah rapuh, dan menggabungkannya menukar draw call dengan
 * artefak visual yang tidak sepadan.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type BatchStats = {
  /** Jumlah mesh di akar yang masuk hitungan, sebelum dan sesudah. */
  meshesBefore: number
  meshesAfter: number
  /** Berapa grup material yang berhasil digabung. */
  mergedGroups: number
  /** Material unik sebelum/sesudah deduplikasi. */
  materialsBefore: number
  materialsAfter: number
}

/** Nama mesh yang harus bertahan sendiri karena jadi target klik atau diubah runtime. */
const KEEP_NAMES = new Set([
  'kanban-board',
  'office-name-plate',
  'office-name-face',
  'lounge-tv-screen',
  'bbq-fire',
])

const KEEP_NAME_PREFIX = ['bbq-smoke-']

/** Atribut yang dibawa saat digabung; sisanya (jarang ada) dibuang. */
const KEEP_ATTRS = ['position', 'normal', 'uv'] as const

/**
 * Kunci material per PROPERTI.
 *
 * Dua material hasil `stdMat(0xa9b7c1, { metal: 0.35 })` dari `box()` yang berbeda
 * memegang objek material berbeda tapi tampilan identik — kunci ini menyatukan mereka
 * sehingga gergedungnya bisa jadi satu mesh.
 */
function materialKey(m: THREE.Material): string {
  const p = m as THREE.MeshStandardMaterial
  const hex = (c?: THREE.Color) => (c ? c.getHexString() : '-')
  return [
    m.type,
    hex(p.color),
    p.roughness,
    p.metalness,
    hex(p.emissive),
    p.emissiveIntensity,
    p.envMapIntensity,
    p.map ? p.map.uuid : '-',
    p.emissiveMap ? p.emissiveMap.uuid : '-',
    p.side,
    p.flatShading ? 1 : 0,
    p.depthWrite ? 1 : 0,
  ].join('|')
}

/** Material yang aman digabung: standar/biasa, buram, satu material (bukan array). */
function isMergeableMaterial(m: THREE.Material | THREE.Material[]): m is THREE.Material {
  if (Array.isArray(m)) return false
  if (m.transparent || m.opacity < 1) return false
  const phys = m as THREE.MeshPhysicalMaterial
  if (phys.transmission && phys.transmission > 0) return false
  const std = m as THREE.MeshStandardMaterial
  const basic = m as THREE.MeshBasicMaterial
  return !!std.isMeshStandardMaterial || !!basic.isMeshBasicMaterial
}

/**
 * Sebuah mesh boleh digabung kalau seluruh rantai induknya bukan penanda dinamis,
 * dia sendiri bukan target klik, dan dia tidak memegang anak non-mesh (label CSS2D
 * yang menempel harus ikut pindah — lebih baik dibiarkan daripada salah pindah).
 */
function isBatchable(mesh: THREE.Mesh, pinned: Set<THREE.Object3D>): boolean {
  if (pinned.has(mesh)) return false
  let o: THREE.Object3D | null = mesh
  while (o) {
    if (o.userData?.dynamic) return false
    o = o.parent
  }
  if (mesh.userData?.kind) return false
  if (KEEP_NAMES.has(mesh.name)) return false
  if (KEEP_NAME_PREFIX.some((p) => mesh.name.startsWith(p))) return false
  if (mesh.children.length > 0) return false
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) return false
  if (!mesh.geometry?.attributes?.position) return false
  if (!isMergeableMaterial(mesh.material)) return false
  return true
}

/**
 * Gabungkan mesh statis di dalam `roots` (group kantor dan group jalan).
 *
 * `pinned` berisi mesh yang dirujuk langsung oleh scene (monitor meja, panel lampu,
 * papan) — objek itu harus tetap jadi objek yang sama karena kodenya memegang
 * referensinya dan mengubah materialnya tiap frame.
 *
 * Mengembalikan statistik dan fungsi `dispose` untuk geometri yang sudah tidak
 * terpakai (geometri lama tidak dibuang otomatis: sebagian bisa dipakai bersama).
 */
export function batchStaticMeshes(
  roots: THREE.Object3D[],
  pinned: Set<THREE.Object3D>,
): BatchStats & { dispose: () => void } {
  for (const r of roots) r.updateMatrixWorld(true)

  // ---- kumpulkan kandidat, kelompokkan per kunci material ---------------------
  const groups = new Map<string, THREE.Mesh[]>()
  let meshesBefore = 0
  const matsSeen = new Set<string>()
  for (const root of roots) {
    root.traverse((raw) => {
      const o = raw as THREE.Mesh
      if (!o.isMesh) return
      meshesBefore++
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[]
      if (!Array.isArray(m)) matsSeen.add(materialKey(m))
      if (!isBatchable(o as THREE.Mesh, pinned)) return
      const key = materialKey(m as THREE.Material)
      const list = groups.get(key)
      if (list) list.push(o as THREE.Mesh)
      else groups.set(key, [o as THREE.Mesh])
    })
  }

  /** Geometri yang masih dipakai mesh lain setelah penghapusan — jangan dibuang. */
  const stillUsed = new Set<THREE.BufferGeometry>()
  const removed: THREE.Mesh[] = []
  const made: THREE.Mesh[] = []
  let mergedGroups = 0

  for (const [, list] of groups) {
    if (list.length < 2) continue
    const material = list[0].material as THREE.Material
    const geos: THREE.BufferGeometry[] = []
    for (const mesh of list) {
      let g = mesh.geometry
      // mergeGeometries menolak campur index/non-index, jadi samakan semua ke non-index.
      g = g.index ? g.toNonIndexed() : g.clone()
      for (const name of Object.keys(g.attributes)) {
        if (!(KEEP_ATTRS as readonly string[]).includes(name)) g.deleteAttribute(name)
      }
      if (!g.attributes.uv) {
        const n = g.attributes.position.count
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
      }
      if (!g.attributes.normal) g.computeVertexNormals()
      // Bake posisi dunia: mesh hasil gabung nanti hidup di akar dengan matriks identitas.
      g.applyMatrix4(mesh.matrixWorld)
      g.clearGroups()
      geos.push(g)
    }
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose()
    if (!merged) {
      // Atribut ternyata tidak kompatibel — biarkan grup ini apa adanya.
      continue
    }
    merged.computeBoundingSphere()
    const mesh = new THREE.Mesh(merged, material)
    mesh.castShadow = list.some((m) => m.castShadow)
    mesh.receiveShadow = list.some((m) => m.receiveShadow)
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    // Semua mesh dalam grup tadi punya akar yang sama? Kalau tidak, tempel ke akar
    // masing-masing tidak mungkin — dalam praktiknya kantor dan jalan adalah dua akar
    // terpisah dan kunci material yang sama di dua akar jarang; tetap kita jaga dengan
    // menempel ke akar dari mesh pertama.
    const owner = ownerOf(list[0], roots)
    owner.add(mesh)
    made.push(mesh)
    mergedGroups++
    for (const m of list) {
      removed.push(m)
      m.parent?.remove(m)
    }
  }

  // ---- buang geometri yang kini yatim -----------------------------------------
  const orphanGeos = new Set<THREE.BufferGeometry>()
  for (const m of removed) {
    const g = m.geometry
    const stillOwned = roots.some((r) => hasGeometry(r, g))
    if (!stillOwned) orphanGeos.add(g)
    else stillUsed.add(g)
  }
  void stillUsed

  let meshesAfter = 0
  const matsAfter = new Set<string>()
  for (const root of roots) {
    root.traverse((raw) => {
      const o = raw as THREE.Mesh
      if (!o.isMesh) return
      meshesAfter++
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[]
      if (!Array.isArray(m)) matsAfter.add(materialKey(m))
    })
  }

  return {
    meshesBefore,
    meshesAfter,
    mergedGroups,
    materialsBefore: matsSeen.size,
    materialsAfter: matsAfter.size,
    dispose() {
      for (const g of orphanGeos) g.dispose()
      for (const m of made) m.geometry.dispose()
    },
  }
}

/** Akar (di antara `roots`) yang menaungi objek itu. */
function ownerOf(o: THREE.Object3D, roots: THREE.Object3D[]): THREE.Object3D {
  let cur: THREE.Object3D | null = o
  while (cur) {
    if (roots.includes(cur)) return cur
    cur = cur.parent
  }
  return roots[0]
}

function hasGeometry(root: THREE.Object3D, g: THREE.BufferGeometry): boolean {
  let found = false
  root.traverse((raw) => {
    const o = raw as THREE.Mesh
    if (found || !o.isMesh) return
    if (o.geometry === g) found = true
  })
  return found
}
