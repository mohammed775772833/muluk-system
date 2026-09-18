const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

// GET /api/services


router.get(
    '/',
    authenticateToken,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    service_id,
                    service_code,
                    service_name,
                    description,
                    standard_price,
                    estimated_hours
                FROM services
                WHERE is_active = true
                ORDER BY service_id ASC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                services: result.rows
            });

        } catch (error) {
            console.error('Get services error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch services'
            });
        }
    }
);

module.exports = router;
