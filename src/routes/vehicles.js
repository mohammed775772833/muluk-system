const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

// GET /api/vehicles
router.get(
    '/',
    authenticateToken,
    requirePermission('VEHICLES_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    v.vehicle_id,
                    v.customer_id,
                    c.customer_no,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    v.plate_no,
                    v.vin,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color,
                    v.mileage,
                    v.notes,
                    v.created_at,
                    v.updated_at
                FROM vehicles v
                JOIN customers c
                    ON c.customer_id = v.customer_id
                ORDER BY v.vehicle_id DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                vehicles: result.rows
            });

        } catch (error) {
            console.error('Get vehicles error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch vehicles'
            });
        }
    }
);

// GET /api/vehicles/:id
router.get(
    '/:id',
    authenticateToken,
    requirePermission('VEHICLES_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    v.vehicle_id,
                    v.customer_id,
                    c.customer_no,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    v.plate_no,
                    v.vin,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color,
                    v.mileage,
                    v.notes,
                    v.created_at,
                    v.updated_at
                FROM vehicles v
                JOIN customers c
                    ON c.customer_id = v.customer_id
                WHERE v.vehicle_id = $1
            `, [req.params.id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Vehicle not found'
                });
            }

            res.json({
                success: true,
                vehicle: result.rows[0]
            });

        } catch (error) {
            console.error('Get vehicle error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch vehicle'
            });
        }
    }
);

// POST /api/vehicles
router.post(
    '/',
    authenticateToken,
    requirePermission('VEHICLES_MANAGE'),
    async (req, res) => {
        try {
            const {
                customer_id,
                plate_no,
                vin,
                make,
                model,
                model_year,
                color,
                mileage,
                notes
            } = req.body;

            if (!customer_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Customer ID is required'
                });
            }

            const customerResult = await pool.query(
                `SELECT customer_id FROM customers WHERE customer_id = $1`,
                [customer_id]
            );

            if (customerResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer not found'
                });
            }

            const result = await pool.query(`
                INSERT INTO vehicles (
                    customer_id,
                    plate_no,
                    vin,
                    make,
                    model,
                    model_year,
                    color,
                    mileage,
                    notes
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9
                )
                RETURNING
                    vehicle_id,
                    customer_id,
                    plate_no,
                    vin,
                    make,
                    model,
                    model_year,
                    color,
                    mileage,
                    notes,
                    created_at,
                    updated_at
            `, [
                customer_id,
                plate_no || null,
                vin || null,
                make || null,
                model || null,
                model_year || null,
                color || null,
                mileage || null,
                notes || null
            ]);

            res.status(201).json({
                success: true,
                message: 'Vehicle created successfully',
                vehicle: result.rows[0]
            });

        } catch (error) {
            console.error('Create vehicle error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to create vehicle'
            });
        }
    }
);

module.exports = router;
