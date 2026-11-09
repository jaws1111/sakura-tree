/**
 * Stage C — CPU Marching Cubes bake of wood SDF → BufferGeometry (SI metres).
 * UVs: u = θ/2π, v = skeleton arc length in metres.
 */

import * as THREE from 'three';
import {
  evaluateWoodSDF,
  projectOnEdge,
  buildEdgeSpatialIndex
} from './sdf.js';
import { BARK_GROOVE_AMP_M } from '../units.js';
import { simplifyVertexClustering } from '../optimize/vertexClusterSimplify.js';

// Classic Marching Cubes edge table (256) + triangle table (compact).
// Generated from Bourke / NVIDIA public domain tables.

const EDGE_TABLE = new Uint16Array([
  0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c, 0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
  0x190, 0x99, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c, 0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
  0x230, 0x339, 0x33, 0x13a, 0x636, 0x73f, 0x435, 0x53c, 0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
  0x3a0, 0x2a9, 0x1a3, 0xaa, 0x7a6, 0x6af, 0x5a5, 0x4ac, 0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
  0x460, 0x569, 0x663, 0x76a, 0x66, 0x16f, 0x265, 0x36c, 0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
  0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0xff, 0x3f5, 0x2fc, 0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
  0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x55, 0x15c, 0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
  0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc, 0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
  0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc, 0xcc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
  0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c, 0x15c, 0x55, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
  0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc, 0x2fc, 0x3f5, 0xff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
  0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c, 0x36c, 0x265, 0x16f, 0x66, 0x76a, 0x663, 0x569, 0x460,
  0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac, 0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa, 0x1a3, 0x2a9, 0x3a0,
  0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c, 0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33, 0x339, 0x230,
  0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c, 0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x99, 0x190,
  0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c, 0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x0
]);

/** Each row: up to 5 triangles (15 edge indices) terminated by -1. */
const TRI_TABLE = [
  [-1], [0, 8, 3, -1], [0, 1, 9, -1], [1, 8, 3, 9, 8, 1, -1], [1, 2, 10, -1], [0, 8, 3, 1, 2, 10, -1],
  [9, 2, 10, 0, 2, 9, -1], [2, 8, 3, 2, 10, 8, 10, 9, 8, -1], [3, 11, 2, -1], [0, 11, 2, 8, 11, 0, -1],
  [1, 9, 0, 2, 3, 11, -1], [1, 11, 2, 1, 9, 11, 9, 8, 11, -1], [3, 10, 1, 11, 10, 3, -1],
  [0, 10, 1, 0, 8, 10, 8, 11, 10, -1], [3, 9, 0, 3, 11, 9, 11, 10, 9, -1], [9, 8, 10, 10, 8, 11, -1],
  [4, 7, 8, -1], [4, 3, 0, 7, 3, 4, -1], [0, 1, 9, 8, 4, 7, -1], [4, 1, 9, 4, 7, 1, 7, 3, 1, -1],
  [1, 2, 10, 8, 4, 7, -1], [3, 4, 7, 3, 0, 4, 1, 2, 10, -1], [9, 2, 10, 9, 0, 2, 8, 4, 7, -1],
  [2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4, -1], [8, 4, 7, 3, 11, 2, -1], [11, 4, 7, 11, 2, 4, 2, 0, 4, -1],
  [9, 0, 1, 8, 4, 7, 2, 3, 11, -1], [4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1, -1],
  [3, 10, 1, 3, 11, 10, 7, 8, 4, -1], [1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4, -1],
  [4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3, -1], [4, 7, 11, 4, 11, 9, 9, 11, 10, -1],
  [9, 5, 4, -1], [9, 5, 4, 0, 8, 3, -1], [0, 5, 4, 1, 5, 0, -1], [8, 5, 4, 8, 3, 5, 3, 1, 5, -1],
  [1, 2, 10, 9, 5, 4, -1], [3, 0, 8, 1, 2, 10, 4, 9, 5, -1], [5, 2, 10, 5, 4, 2, 4, 0, 2, -1],
  [2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8, -1], [9, 5, 4, 2, 3, 11, -1], [0, 11, 2, 0, 8, 11, 4, 9, 5, -1],
  [0, 5, 4, 0, 1, 5, 2, 3, 11, -1], [2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5, -1],
  [10, 3, 11, 10, 1, 3, 9, 5, 4, -1], [4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10, -1],
  [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3, -1], [5, 4, 8, 5, 8, 10, 10, 8, 11, -1],
  [9, 7, 8, 5, 7, 9, -1], [9, 3, 0, 9, 5, 3, 5, 7, 3, -1], [0, 7, 8, 0, 1, 7, 1, 5, 7, -1],
  [1, 5, 3, 3, 5, 7, -1], [9, 7, 8, 9, 5, 7, 10, 1, 2, -1], [10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3, -1],
  [8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2, -1], [2, 10, 5, 2, 5, 3, 3, 5, 7, -1],
  [7, 9, 5, 7, 8, 9, 3, 11, 2, -1], [9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11, -1],
  [2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7, -1], [11, 2, 1, 11, 1, 7, 7, 1, 5, -1],
  [9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11, -1], [5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0, -1],
  [11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0, -1], [11, 10, 5, 7, 11, 5, -1],
  [10, 6, 5, -1], [0, 8, 3, 5, 10, 6, -1], [9, 0, 1, 5, 10, 6, -1], [1, 8, 3, 1, 9, 8, 5, 10, 6, -1],
  [1, 6, 5, 2, 6, 1, -1], [1, 6, 5, 1, 2, 6, 3, 0, 8, -1], [9, 6, 5, 9, 0, 6, 0, 2, 6, -1],
  [5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8, -1], [2, 3, 11, 10, 6, 5, -1], [11, 0, 8, 11, 2, 0, 10, 6, 5, -1],
  [0, 1, 9, 2, 3, 11, 5, 10, 6, -1], [5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11, -1],
  [6, 3, 11, 6, 5, 3, 5, 1, 3, -1], [0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6, -1],
  [3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9, -1], [6, 5, 9, 6, 9, 11, 11, 9, 8, -1],
  [5, 10, 6, 4, 7, 8, -1], [4, 3, 0, 4, 7, 3, 6, 5, 10, -1], [1, 9, 0, 5, 10, 6, 8, 4, 7, -1],
  [10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4, -1], [6, 1, 2, 6, 5, 1, 4, 7, 8, -1],
  [1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7, -1], [8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6, -1],
  [7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9, -1], [3, 11, 2, 7, 8, 4, 10, 6, 5, -1],
  [5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11, -1], [0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6, -1],
  [9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6, -1], [8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6, -1],
  [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11, -1], [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7, -1],
  [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9, -1], [10, 4, 9, 6, 4, 10, -1], [4, 10, 6, 4, 9, 10, 0, 8, 3, -1],
  [10, 0, 1, 10, 6, 0, 6, 4, 0, -1], [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10, -1],
  [1, 4, 9, 1, 2, 4, 2, 6, 4, -1], [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4, -1], [0, 2, 4, 4, 2, 6, -1],
  [8, 3, 2, 8, 2, 4, 4, 2, 6, -1], [10, 4, 9, 10, 6, 4, 11, 2, 3, -1], [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6, -1],
  [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10, -1], [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1, -1],
  [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3, -1], [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1, -1],
  [3, 11, 6, 3, 6, 0, 0, 6, 4, -1], [6, 4, 8, 11, 6, 8, -1], [7, 10, 6, 7, 8, 10, 8, 9, 10, -1],
  [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10, -1], [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0, -1],
  [10, 6, 7, 10, 7, 1, 1, 7, 3, -1], [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7, -1],
  [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9, -1], [7, 8, 0, 7, 0, 6, 6, 0, 2, -1],
  [7, 3, 2, 6, 7, 2, -1], [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7, -1],
  [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7, -1], [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11, -1],
  [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1, -1], [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6, -1],
  [0, 9, 1, 11, 6, 7, -1], [7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0, -1], [7, 11, 6, -1],
  [7, 6, 11, -1], [3, 0, 8, 11, 7, 6, -1], [0, 1, 9, 11, 7, 6, -1], [8, 1, 9, 8, 3, 1, 11, 7, 6, -1],
  [10, 1, 2, 6, 11, 7, -1], [1, 2, 10, 3, 0, 8, 6, 11, 7, -1], [2, 9, 0, 2, 10, 9, 6, 11, 7, -1],
  [6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8, -1], [7, 2, 3, 6, 2, 7, -1], [7, 0, 8, 7, 6, 0, 6, 2, 0, -1],
  [2, 7, 6, 2, 3, 7, 0, 1, 9, -1], [1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6, -1],
  [10, 7, 6, 10, 1, 7, 1, 3, 7, -1], [10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8, -1],
  [0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7, -1], [7, 6, 10, 7, 10, 8, 8, 10, 9, -1],
  [6, 8, 4, 11, 8, 6, -1], [3, 6, 11, 3, 0, 6, 0, 4, 6, -1], [8, 6, 11, 8, 4, 6, 9, 0, 1, -1],
  [9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6, -1], [6, 8, 4, 6, 11, 8, 2, 10, 1, -1],
  [1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6, -1], [4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9, -1],
  [10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3, -1], [8, 2, 3, 8, 4, 2, 4, 6, 2, -1],
  [0, 4, 2, 4, 6, 2, -1], [1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8, -1], [1, 9, 4, 1, 4, 2, 2, 4, 6, -1],
  [8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1, -1], [10, 1, 0, 10, 0, 6, 6, 0, 4, -1],
  [4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3, -1], [10, 9, 4, 6, 10, 4, -1],
  [4, 9, 5, 7, 6, 11, -1], [0, 8, 3, 4, 9, 5, 11, 7, 6, -1], [5, 0, 1, 5, 4, 0, 7, 6, 11, -1],
  [11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5, -1], [9, 5, 4, 10, 1, 2, 7, 6, 11, -1],
  [6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5, -1], [7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2, -1],
  [3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6, -1], [7, 2, 3, 7, 6, 2, 5, 4, 9, -1],
  [9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7, -1], [3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0, -1],
  [6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8, -1], [9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7, -1],
  [1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4, -1], [4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10, -1],
  [7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10, -1], [6, 9, 5, 6, 11, 9, 11, 8, 9, -1],
  [3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5, -1], [0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11, -1],
  [6, 11, 3, 6, 3, 5, 5, 3, 1, -1], [1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6, -1],
  [0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10, -1], [11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5, -1],
  [6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3, -1], [5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2, -1],
  [9, 5, 6, 9, 6, 0, 0, 6, 2, -1], [1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8, -1],
  [1, 5, 6, 2, 1, 6, -1], [1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6, -1],
  [10, 1, 0, 10, 0, 6, 9, 5, 0, 5, 6, 0, -1], [0, 3, 8, 5, 6, 10, -1], [10, 5, 6, -1],
  [11, 5, 10, 7, 5, 11, -1], [11, 5, 10, 11, 7, 5, 8, 3, 0, -1], [5, 11, 7, 5, 10, 11, 1, 9, 0, -1],
  [10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1, -1], [11, 1, 2, 11, 7, 1, 7, 5, 1, -1],
  [0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11, -1], [9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7, -1],
  [7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2, -1], [2, 5, 10, 2, 3, 5, 3, 7, 5, -1],
  [8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5, -1], [9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2, -1],
  [9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2, -1], [1, 3, 5, 3, 7, 5, -1],
  [0, 8, 7, 0, 7, 1, 1, 7, 5, -1], [9, 0, 3, 9, 3, 5, 5, 3, 7, -1], [9, 8, 7, 5, 9, 7, -1],
  [5, 8, 4, 5, 10, 8, 10, 11, 8, -1], [5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0, -1],
  [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5, -1], [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4, -1],
  [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8, -1], [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11, -1],
  [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5, -1], [9, 4, 5, 2, 11, 3, -1],
  [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4, -1], [5, 10, 2, 5, 2, 4, 4, 2, 0, -1],
  [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9, -1], [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2, -1],
  [8, 4, 5, 8, 5, 3, 3, 5, 1, -1], [0, 4, 5, 1, 0, 5, -1], [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5, -1],
  [9, 4, 5, -1], [4, 11, 7, 4, 9, 11, 9, 10, 11, -1], [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11, -1],
  [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11, -1], [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4, -1],
  [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2, -1], [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3, -1],
  [11, 7, 4, 11, 4, 2, 2, 4, 0, -1], [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4, -1],
  [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9, -1], [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7, -1],
  [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10, -1], [1, 10, 2, 8, 7, 4, -1],
  [4, 9, 1, 4, 1, 7, 7, 1, 3, -1], [4, 9, 1, 4, 1, 7, 0, 8, 1, 8, 7, 1, -1],
  [4, 0, 3, 7, 4, 3, -1], [4, 8, 7, -1], [9, 10, 8, 10, 11, 8, -1],
  [3, 0, 9, 3, 9, 11, 11, 9, 10, -1], [0, 1, 10, 0, 10, 8, 8, 10, 11, -1], [3, 1, 10, 11, 3, 10, -1],
  [1, 2, 11, 1, 11, 9, 9, 11, 8, -1], [3, 0, 9, 3, 9, 11, 1, 2, 9, 2, 11, 9, -1],
  [0, 2, 11, 8, 0, 11, -1], [3, 2, 11, -1], [2, 3, 8, 2, 8, 10, 10, 8, 9, -1],
  [9, 10, 2, 0, 9, 2, -1], [2, 3, 8, 2, 8, 10, 0, 1, 8, 1, 10, 8, -1], [1, 10, 2, -1],
  [1, 3, 8, 9, 1, 8, -1], [0, 9, 1, -1], [0, 3, 8, -1], [-1]
];

const CUBE_VERTS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
];

const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7]
];

/**
 * Build a coarse occupancy mask: voxels near any edge AABB are candidates.
 */
function buildNarrowBand(edges, origin, dims, voxelM, padM) {
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(nx * ny * nz);
  const inv = 1 / voxelM;

  for (const e of edges) {
    const rPad = Math.max(e.ra, e.rb) + padM;
    const minX = Math.min(e.pa.x, e.pb.x) - rPad;
    const minY = Math.min(e.pa.y, e.pb.y) - rPad;
    const minZ = Math.min(e.pa.z, e.pb.z) - rPad;
    const maxX = Math.max(e.pa.x, e.pb.x) + rPad;
    const maxY = Math.max(e.pa.y, e.pb.y) + rPad;
    const maxZ = Math.max(e.pa.z, e.pb.z) + rPad;

    const i0 = Math.max(0, Math.floor((minX - origin.x) * inv));
    const j0 = Math.max(0, Math.floor((minY - origin.y) * inv));
    const k0 = Math.max(0, Math.floor((minZ - origin.z) * inv));
    const i1 = Math.min(nx - 1, Math.ceil((maxX - origin.x) * inv));
    const j1 = Math.min(ny - 1, Math.ceil((maxY - origin.y) * inv));
    const k1 = Math.min(nz - 1, Math.ceil((maxZ - origin.z) * inv));

    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          mask[i + nx * (j + ny * k)] = 1;
        }
      }
    }
  }
  return mask;
}

function lerpIso(iso, v0, v1, p0, p1) {
  const d = v1 - v0;
  const t = Math.abs(d) < 1e-12 ? 0.5 : (iso - v0) / d;
  return {
    x: p0.x + (p1.x - p0.x) * t,
    y: p0.y + (p1.y - p0.y) * t,
    z: p0.z + (p1.z - p0.z) * t
  };
}

/**
 * Remap vertex → (u,v) from nearest skeleton edge.
 * u = θ/2π, v = arc length (m).
 */
export function remapUVs(positions, edges) {
  const n = positions.length / 3;
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = {
      x: positions[i * 3],
      y: positions[i * 3 + 1],
      z: positions[i * 3 + 2]
    };
    let best = edges[0];
    let bestD = Infinity;
    for (const e of edges) {
      const pr = projectOnEdge(p, e);
      const dx = p.x - pr.C.x;
      const dy = p.y - pr.C.y;
      const dz = p.z - pr.C.z;
      const d = Math.hypot(dx, dy, dz) - pr.r;
      const ad = Math.abs(d);
      if (ad < bestD) {
        bestD = ad;
        best = e;
      }
    }
    const pr = projectOnEdge(p, best);
    const qx = p.x - pr.C.x;
    const qy = p.y - pr.C.y;
    const qz = p.z - pr.C.z;
    const nDot = qx * pr.N.x + qy * pr.N.y + qz * pr.N.z;
    const bDot = qx * pr.B.x + qy * pr.B.y + qz * pr.B.z;
    let theta = Math.atan2(nDot, bDot);
    if (theta < 0) theta += Math.PI * 2;
    uvs[i * 2] = theta / (Math.PI * 2);
    uvs[i * 2 + 1] = pr.s;
  }
  return uvs;
}

/**
 * Weld vertices within ε and rebuild index buffer.
 */
export function weldVertices(positions, normals, indices, eps) {
  const n = positions.length / 3;
  const cell = eps;
  const inv = 1 / cell;
  const hash = new Map();
  const keyOf = (x, y, z) =>
    `${Math.round(x * inv)}|${Math.round(y * inv)}|${Math.round(z * inv)}`;

  const map = new Int32Array(n);
  const outPos = [];
  const outNor = [];
  let next = 0;

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const k = keyOf(x, y, z);
    let id = hash.get(k);
    if (id === undefined) {
      id = next++;
      hash.set(k, id);
      outPos.push(x, y, z);
      outNor.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    } else {
      // Average normals
      outNor[id * 3] += normals[i * 3];
      outNor[id * 3 + 1] += normals[i * 3 + 1];
      outNor[id * 3 + 2] += normals[i * 3 + 2];
    }
    map[i] = id;
  }

  for (let i = 0; i < next; i++) {
    const L = Math.hypot(outNor[i * 3], outNor[i * 3 + 1], outNor[i * 3 + 2]) || 1;
    outNor[i * 3] /= L;
    outNor[i * 3 + 1] /= L;
    outNor[i * 3 + 2] /= L;
  }

  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIdx[i] = map[indices[i]];

  return {
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNor),
    indices: outIdx
  };
}

/**
 * Marching Cubes over AABB with narrow-band occupancy.
 *
 * @param {import('./skeleton.js').Skeleton} skeleton
 * @param {object} [opts]
 * @returns {{ geometry: THREE.BufferGeometry, stats: object }}
 */
export function bakeMarchingCubes(skeleton, opts = {}) {
  const {
    voxelM = 0.055,
    iso = 0,
    nearestK = 14,
    includeBark = true,
    /** Cluster cell as multiple of voxel — removes sub-shading MC noise. */
    simplifyCellScale = 1.15
  } = opts;

  // Twigs thinner than ~1.5 voxels are skipped (spec §3.3); capsule LOD later.
  const minMcRadius = 1.5 * voxelM;
  const edges = skeleton.edges.filter(
    (e) => Math.max(e.ra, e.rb) >= minMcRadius * 0.55
  );
  const pad = 0.06 + BARK_GROOVE_AMP_M;
  const min = {
    x: skeleton.bounds.min.x - 0.02,
    // Allow negative Y so underground roots are meshed (do not clamp to 0)
    y: skeleton.bounds.min.y - 0.02,
    z: skeleton.bounds.min.z - 0.02
  };
  const max = {
    x: skeleton.bounds.max.x + 0.02,
    y: skeleton.bounds.max.y + 0.02,
    z: skeleton.bounds.max.z + 0.02
  };

  const nx = Math.max(2, Math.ceil((max.x - min.x) / voxelM) + 1);
  const ny = Math.max(2, Math.ceil((max.y - min.y) / voxelM) + 1);
  const nz = Math.max(2, Math.ceil((max.z - min.z) / voxelM) + 1);

  const spatialIndex = buildEdgeSpatialIndex(edges, Math.max(0.3, voxelM * 6));
  const sdfOpts = { nearestK, includeBark, spatialIndex };
  const mask = buildNarrowBand(edges, min, [nx, ny, nz], voxelM, pad);

  // Sample field only on narrow band (+1 halo for cube corners)
  const field = new Float32Array(nx * ny * nz);
  field.fill(1e3);
  let samples = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * (j + ny * k);
        // include neighbour occupancy so cube corners exist
        let occ = mask[idx];
        if (!occ) {
          for (let dk = -1; dk <= 1 && !occ; dk++) {
            for (let dj = -1; dj <= 1 && !occ; dj++) {
              for (let di = -1; di <= 1 && !occ; di++) {
                const ii = i + di;
                const jj = j + dj;
                const kk = k + dk;
                if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
                if (mask[ii + nx * (jj + ny * kk)]) occ = 1;
              }
            }
          }
        }
        if (!occ) continue;
        const p = {
          x: min.x + i * voxelM,
          y: min.y + j * voxelM,
          z: min.z + k * voxelM
        };
        field[idx] = evaluateWoodSDF(p, edges, sdfOpts);
        samples += 1;
      }
    }
  }

  const pos = [];
  const nor = [];
  const idxList = [];
  let vertCount = 0;

  const cornerPos = new Array(8);
  const cornerVal = new Float32Array(8);
  const edgeVert = new Array(12);

  /** Sample ∇f from the already-baked field grid (central differences). */
  const sampleFieldGrad = (p) => {
    const fi = (p.x - min.x) / voxelM;
    const fj = (p.y - min.y) / voxelM;
    const fk = (p.z - min.z) / voxelM;
    const i = Math.max(1, Math.min(nx - 2, Math.round(fi)));
    const j = Math.max(1, Math.min(ny - 2, Math.round(fj)));
    const k = Math.max(1, Math.min(nz - 2, Math.round(fk)));
    const at = (ii, jj, kk) => field[ii + nx * (jj + ny * kk)];
    const gx = (at(i + 1, j, k) - at(i - 1, j, k)) / (2 * voxelM);
    const gy = (at(i, j + 1, k) - at(i, j - 1, k)) / (2 * voxelM);
    const gz = (at(i, j, k + 1) - at(i, j, k - 1)) / (2 * voxelM);
    const L = Math.hypot(gx, gy, gz) || 1;
    return { x: gx / L, y: gy / L, z: gz / L };
  };

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        // Skip empty cubes
        let any = false;
        for (let c = 0; c < 8; c++) {
          const [cx, cy, cz] = CUBE_VERTS[c];
          const ii = i + cx;
          const jj = j + cy;
          const kk = k + cz;
          const id = ii + nx * (jj + ny * kk);
          if (mask[id] || field[id] < 500) any = true;
          cornerVal[c] = field[id];
          cornerPos[c] = {
            x: min.x + ii * voxelM,
            y: min.y + jj * voxelM,
            z: min.z + kk * voxelM
          };
        }
        if (!any) continue;

        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          if (cornerVal[c] < iso) cubeIndex |= 1 << c;
        }
        const edgesMask = EDGE_TABLE[cubeIndex];
        if (edgesMask === 0) continue;

        for (let e = 0; e < 12; e++) {
          if (edgesMask & (1 << e)) {
            const [a, b] = CUBE_EDGES[e];
            edgeVert[e] = lerpIso(iso, cornerVal[a], cornerVal[b], cornerPos[a], cornerPos[b]);
          }
        }

        const tri = TRI_TABLE[cubeIndex];
        for (let t = 0; tri[t] !== -1; t += 3) {
          const v0 = edgeVert[tri[t]];
          const v1 = edgeVert[tri[t + 1]];
          const v2 = edgeVert[tri[t + 2]];
          const g0 = sampleFieldGrad(v0);
          const g1 = sampleFieldGrad(v1);
          const g2 = sampleFieldGrad(v2);

          pos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
          nor.push(g0.x, g0.y, g0.z, g1.x, g1.y, g1.z, g2.x, g2.y, g2.z);
          idxList.push(vertCount, vertCount + 1, vertCount + 2);
          vertCount += 3;
        }
      }
    }
  }

  let positions = new Float32Array(pos);
  let normals = new Float32Array(nor);
  let indices = new Uint32Array(idxList);

  const welded = weldVertices(positions, normals, indices, 0.25 * voxelM);
  positions = welded.positions;
  normals = welded.normals;
  indices = welded.indices;

  let uvs = remapUVs(positions, edges);

  // Scientific reduce: cluster vertices so display mesh matches shading Nyquist
  let simplifyStats = null;
  if (simplifyCellScale > 0) {
    const simplified = simplifyVertexClustering(
      positions,
      normals,
      uvs,
      indices,
      voxelM * simplifyCellScale
    );
    simplifyStats = simplified.stats;
    positions = simplified.positions;
    normals = simplified.normals;
    indices = simplified.indices;
    uvs = simplified.uvs || remapUVs(positions, edges);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const bb = geometry.boundingBox;
  const triangleCount = indices.length / 3;

  return {
    geometry,
    stats: {
      voxelM,
      grid: [nx, ny, nz],
      samples,
      vertices: positions.length / 3,
      triangles: triangleCount,
      simplify: simplifyStats,
      boundsMinM: bb ? { x: bb.min.x, y: bb.min.y, z: bb.min.z } : null,
      boundsMaxM: bb ? { x: bb.max.x, y: bb.max.y, z: bb.max.z } : null
    }
  };
}
