const express = require('express');
const router = express.Router();

const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

router.get('/', authenticateToken, requirePermission('INVENTORY_VIEW'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                material_id,
                material_code,
                material_name,
                category,
                unit,
                specification,
                minimum_stock,
                standard_cost,
                preferred_supplier_id,
                is_active,
                created_at,
                updated_at
            FROM materials
            WHERE is_active = true
            ORDER BY material_name
        `);

        res.json({
            success: true,
            count: result.rows.length,
            materials: result.rows
        });

    } catch (error) {
        console.error('Get materials error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get materials'
        });
    }
});

module.exports = router;
