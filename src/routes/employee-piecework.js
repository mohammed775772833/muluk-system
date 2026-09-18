const express = require('express');
const pool = require('../../db');
const { authenticateToken, requirePermission } = require('../middleware/auth');

const router = express.Router();
const ALLOWED_STATUSES = ['DUE', 'APPROVED', 'PAID', 'CANCELLED'];


// GET all piecework wages
router.get('/', authenticateToken, requirePermission('PIECEWORK_VIEW'), async (req, res) => {
    try {
        const isManager = (req.user.permissions || []).includes('PIECEWORK_MANAGE');

        const params = [];
        let employeeFilter = '';

        if (!isManager) {
            if (!req.user.employee_id) {
                return res.status(403).json({
                    success: false,
                    message: 'Employee account is not linked to an employee'
                });
            }

            params.push(req.user.employee_id);
            employeeFilter = `WHERE ep.employee_id = $${params.length}`;
        }

        const result = await pool.query(`
            SELECT
                ep.piecework_id,
                ep.work_order_id,
                wo.work_order_no,
                ep.employee_id,
                e.employee_no,
                e.full_name,
                ep.stage_id,
                ws.stage_name,
                ep.work_description,
                ep.amount,
                ep.status,
                ep.notes,
                ep.created_at,
                ep.updated_at
            FROM employee_piecework ep
            JOIN work_orders wo
                ON wo.work_order_id = ep.work_order_id
            JOIN employees e
                ON e.employee_id = ep.employee_id
            LEFT JOIN work_order_stages ws
                ON ws.stage_id = ep.stage_id
            ${employeeFilter}
            ORDER BY ep.piecework_id DESC
        `, params);

        res.json({
            success: true,
            count: result.rows.length,
            piecework: result.rows
        });
    } catch (error) {
        console.error('Get piecework error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get piecework wages'
        });
    }
});


// GET employee piecework summary
router.get('/summary/employees', authenticateToken, requirePermission('PIECEWORK_VIEW'), async (req, res) => {
    try {
        const { from, to, employee_id } = req.query;

        const isManager = (req.user.permissions || []).includes('PIECEWORK_MANAGE');

        const conditions = [];
        const params = [];

        if (from) {
            params.push(from);
            conditions.push(`ep.created_at >= $${params.length}::date`);
        }

        if (to) {
            params.push(to);
            conditions.push(`ep.created_at < ($${params.length}::date + INTERVAL '1 day')`);
        }

        if (isManager) {
            if (employee_id) {
                params.push(employee_id);
                conditions.push(`ep.employee_id = $${params.length}`);
            }
        } else {
            if (!req.user.employee_id) {
                return res.status(403).json({
                    success: false,
                    message: 'Employee account is not linked to an employee'
                });
            }

            params.push(req.user.employee_id);
            conditions.push(`ep.employee_id = $${params.length}`);
        }

        const joinConditions = conditions.length
            ? 'AND ' + conditions.join(' AND ')
            : '';

        const result = await pool.query(`
            SELECT
                e.employee_id,
                e.employee_no,
                e.full_name,
                COUNT(ep.piecework_id)::integer AS work_count,
                COALESCE(SUM(ep.amount), 0)::numeric(14,2) AS total_amount,
                COALESCE(SUM(
                    CASE WHEN ep.status = 'PAID'
                        THEN ep.amount ELSE 0 END
                ), 0)::numeric(14,2) AS paid_amount,
                COALESCE(SUM(
                    CASE WHEN ep.status IN ('DUE', 'APPROVED')
                        THEN ep.amount ELSE 0 END
                ), 0)::numeric(14,2) AS due_amount
            FROM employees e
            LEFT JOIN employee_piecework ep
                ON ep.employee_id = e.employee_id
                ${joinConditions}
            ${isManager ? '' : `WHERE e.employee_id = $${params.length}`}
            GROUP BY
                e.employee_id,
                e.employee_no,
                e.full_name
            ORDER BY e.employee_id
        `, params);

        const totals = result.rows.reduce((acc, row) => {
            acc.work_count += Number(row.work_count || 0);
            acc.total_amount += Number(row.total_amount || 0);
            acc.paid_amount += Number(row.paid_amount || 0);
            acc.due_amount += Number(row.due_amount || 0);
            return acc;
        }, {
            work_count: 0,
            total_amount: 0,
            paid_amount: 0,
            due_amount: 0
        });

        res.json({
            success: true,
            filters: {
                from: from || null,
                to: to || null,
                employee_id: isManager
                    ? (employee_id || null)
                    : req.user.employee_id
            },
            totals,
            employees: result.rows
        });

    } catch (error) {
        console.error('Get piecework summary error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get piecework summary'
        });
    }
});

// GET one piecework wage
router.get('/:id', authenticateToken, requirePermission('EMPLOYEES_VIEW'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT
                ep.piecework_id,
                ep.work_order_id,
                wo.work_order_no,
                ep.employee_id,
                e.employee_no,
                e.full_name,
                ep.stage_id,
                ws.stage_name,
                ep.work_description,
                ep.amount,
                ep.status,
                ep.notes,
                ep.created_at,
                ep.updated_at
            FROM employee_piecework ep
            JOIN work_orders wo
                ON wo.work_order_id = ep.work_order_id
            JOIN employees e
                ON e.employee_id = ep.employee_id
            LEFT JOIN work_order_stages ws
                ON ws.stage_id = ep.stage_id
            WHERE ep.piecework_id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Piecework wage not found'
            });
        }

        res.json({
            success: true,
            piecework: result.rows[0]
        });
    } catch (error) {
        console.error('Get piecework error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get piecework wage'
        });
    }
});

// CREATE piecework wage
router.post('/', authenticateToken, requirePermission('EMPLOYEES_MANAGE'), async (req, res) => {
    try {
        const {
            work_order_id,
            employee_id,
            stage_id,
            work_description,
            amount,
            status,
            notes
        } = req.body;

        if (status && !ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid piecework status'
            });
        }

        if (!work_order_id || !employee_id || !work_description || amount === undefined) {
            return res.status(400).json({
                success: false,
                message: 'work_order_id, employee_id, work_description and amount are required'
            });
        }

        const result = await pool.query(`
            INSERT INTO employee_piecework (
                work_order_id,
                employee_id,
                stage_id,
                work_description,
                amount,
                status,
                notes
            )
            VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'DUE'), $7)
            RETURNING
                piecework_id,
                work_order_id,
                employee_id,
                stage_id,
                work_description,
                amount,
                status,
                notes,
                created_at,
                updated_at
        `, [
            work_order_id,
            employee_id,
            stage_id || null,
            work_description.trim(),
            amount,
            status || null,
            notes || null
        ]);

        res.status(201).json({
            success: true,
            message: 'Piecework wage created successfully',
            piecework: result.rows[0]
        });
    } catch (error) {
        console.error('Create piecework error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to create piecework wage'
        });
    }
});

// UPDATE piecework wage
router.patch('/:id', authenticateToken, requirePermission('EMPLOYEES_MANAGE'), async (req, res) => {
    try {
        const { id } = req.params;

        const {
            work_order_id,
            employee_id,
            stage_id,
            work_description,
            amount,
            status,
            notes
        } = req.body;

        if (status && !ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid piecework status'
            });
        }

        if (!work_order_id || !employee_id || !work_description || amount === undefined) {
            return res.status(400).json({
                success: false,
                message: 'work_order_id, employee_id, work_description and amount are required'
            });
        }

        const result = await pool.query(`
            UPDATE employee_piecework
            SET
                work_order_id = $1,
                employee_id = $2,
                stage_id = $3,
                work_description = $4,
                amount = $5,
                status = COALESCE($6, status),
                notes = $7,
                updated_at = CURRENT_TIMESTAMP
            WHERE piecework_id = $8
            RETURNING
                piecework_id,
                work_order_id,
                employee_id,
                stage_id,
                work_description,
                amount,
                status,
                notes,
                created_at,
                updated_at
        `, [
            work_order_id,
            employee_id,
            stage_id || null,
            work_description.trim(),
            amount,
            status || null,
            notes || null,
            id
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Piecework wage not found'
            });
        }

        res.json({
            success: true,
            message: 'Piecework wage updated successfully',
            piecework: result.rows[0]
        });
    } catch (error) {
        console.error('Update piecework error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to update piecework wage'
        });
    }
});

module.exports = router;
